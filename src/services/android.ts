import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { once } from "events";
import { config } from "../config";
import { extractYouTubeId, readBodyCapped, assertSafeMediaUrl } from "./invidious";
import { TooLargeError } from "./quality";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * Direct youtubei player API with multi-client rotation.
 *
 * NOTE: this uses OUR OWN server IP (unlike Piped/Invidious, which use
 * theirs), so it wins a different per-(video, IP) lottery draw with YouTube's
 * bot-wall. Client identity matters enormously: YouTube walls per
 * (video, IP, client), so ANDROID may 403 while IOS or WEB returns
 * playability=OK for the SAME video from the SAME IP. We therefore rotate
 * through several client identities and return the first that yields a
 * direct progressive MP4 URL.
 *
 * Verified Sep 2026: ANDROID 20.10.38 with a full MOBILE context returns
 * playability=OK + progressive itag 18/22 for unwalled videos, while older
 * ANDROID 19.x returns nothing at all (YouTube killed it).
 */

const KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";

interface YoutubeiClient {
  name: string;
  userAgent: string;
  origin?: string;
  context: Record<string, unknown>;
}

const YOUTUBEI_CLIENTS: YoutubeiClient[] = [
  {
    name: "ANDROID",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip",
    origin: "https://www.youtube.com",
    context: {
      client: {
        clientName: "ANDROID",
        clientVersion: "20.10.38",
        androidSdkVersion: 30,
        osName: "Android",
        osVersion: "11",
        platform: "MOBILE",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    name: "IOS",
    userAgent: "com.google.ios.youtube/20.10.38 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)",
    origin: "https://www.youtube.com",
    context: {
      client: {
        clientName: "IOS",
        clientVersion: "20.10.38",
        deviceMake: "Apple",
        deviceModel: "iPhone16,2",
        osName: "iPhone",
        osVersion: "17.5.1",
        platform: "MOBILE",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    name: "MWEB",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
    origin: "https://m.youtube.com",
    context: {
      client: {
        clientName: "MWEB",
        clientVersion: "2.20250212.01.00",
        platform: "MOBILE",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    name: "WEB",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    origin: "https://www.youtube.com",
    context: {
      client: {
        clientName: "WEB",
        clientVersion: "2.20250222.10.00",
        platform: "DESKTOP",
        hl: "en",
        gl: "US",
      },
    },
  },
  {
    name: "TV",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    origin: "https://www.youtube.com",
    context: {
      client: {
        clientName: "TVHTML5",
        clientVersion: "7.20250212.10.00",
        platform: "TV",
        hl: "en",
        gl: "US",
      },
    },
  },
];

interface YoutubeiFormat {
  itag?: number;
  url?: string;
  signatureCipher?: string;
  mimeType?: string;
  width?: number;
  height?: number;
}

interface YoutubeiResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { formats?: YoutubeiFormat[]; adaptiveFormats?: YoutubeiFormat[] };
  videoDetails?: { title?: string };
}

function pickProgressive(formats: YoutubeiFormat[], maxHeight: number): YoutubeiFormat | null {
  return pickProgressiveSorted(formats, maxHeight)[0] || null;
}

/** All direct progressive MP4s sorted best-first (for lower-quality retries). */
function pickProgressiveSorted(formats: YoutubeiFormat[], maxHeight: number): YoutubeiFormat[] {
  // Direct `url` only — signatureCipher needs player-JS deciphering (that's
  // yt-dlp's job; we deliberately don't do it here).
  const direct = formats.filter(
    (f) => f.url && (f.mimeType || "").includes("video/mp4")
  );
  if (direct.length === 0) return [];
  const withH = direct.map((f) => ({ f, h: f.height || 0 }));
  const known = withH.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
  const unknown = withH.filter((x) => x.h <= 0).map((x) => x.f);
  if (maxHeight > 0) {
    const fitting = known.filter((x) => x.h <= maxHeight).map((x) => x.f);
    const smaller = known.filter((x) => x.h > maxHeight).sort((a, b) => a.h - b.h).map((x) => x.f);
    if (fitting.length > 0) return [...fitting, ...unknown, ...smaller];
    return [...known.sort((a, b) => a.h - b.h).map((x) => x.f), ...unknown];
  }
  return [...known.map((x) => x.f), ...unknown];
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

async function streamToFile(
  fileUrl: string,
  filePath: string,
  userAgent: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  // SSRF guard: never fetch a non-public host from a provider payload.
  assertSafeMediaUrl(fileUrl);
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": userAgent },
      signal: controller.signal,
    });
    const body = res.body;
    if (!res.ok || !body) {
      // Release the socket for a body we are not going to read.
      try {
        await body?.cancel();
      } catch {}
      throw new Error(`Video server HTTP ${res.status}`);
    }
    const total = Number(res.headers.get("content-length") || 0);
    if (total > maxBytes) {
      try {
        await body.cancel();
      } catch {}
      throw new TooLargeError(`❌ This quality is over ${config.maxFileSizeMB}MB — trying a lower quality…`);
    }
    const file = fs.createWriteStream(filePath);
    // A write-side failure (disk full, permissions) is emitted as an 'error'
    // event. With no listener Node turns it into an uncaught exception and
    // kills the whole bot — and the drain wait below would never settle.
    let writeError: Error | null = null;
    file.on("error", (err) => {
      writeError = writeError || err;
    });
    let received = 0;
    let tooLarge = false;
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > maxBytes) {
          // Do NOT destroy() here: end() on a destroyed stream rejects with
          // ERR_STREAM_DESTROYED, which REPLACES this TooLargeError and makes
          // the caller treat "retry a lower rendition" as a provider failure.
          // Stop reading, close the file cleanly, delete it below.
          tooLarge = true;
          break;
        }
        if (!file.write(chunk)) {
          // No 'drain' will ever arrive on an already-failed stream — fail
          // fast instead of hanging. events.once() covers a failure that
          // happens while waiting, so this wait always settles.
          if (writeError) throw writeError;
          await once(file, "drain");
        }
        if (total > 0 && onProgress) onProgress({ percent: (received / total) * 100 });
      }
    } finally {
      // Close (or finish closing) unconditionally so no half-open handle or
      // partial file is left behind, and never let this throw: it would mask
      // the real error that sent us here.
      await new Promise<void>((resolve) => {
        file.end((err?: Error | null) => {
          if (err) writeError = writeError || err;
          resolve();
        });
      });
    }
    if (writeError) throw writeError;
    if (tooLarge) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      throw new TooLargeError(`❌ This quality is over ${config.maxFileSizeMB}MB — trying a lower quality…`);
    }
  } catch (err: any) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    if (err instanceof TooLargeError) throw err;
    // NOTE: no ❌ prefix — the caller treats ❌ as a definitive verdict on the
    // video; a slow/aborted media host is only this client's stream failing.
    if (err?.name === "AbortError") throw new Error("Download timed out (video server too slow or blocked).");
    throw err instanceof Error ? err : new Error(`❌ Download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cookie-free YouTube resort: talk to YouTube's player API directly, rotating
 * through several client identities (ANDROID → IOS → MWEB → WEB → TV). No
 * yt-dlp, no cookies, no third party — just HTTPS POSTs from our own IP and
 * a plain download of the returned progressive MP4 (typically 360p, ideal
 * for Telegram's size limits).
 *
 * Each client is an independent lottery draw with the per-(video, IP,
 * client) bot-wall: one client may be LOGIN_REQUIRED while the next returns
 * OK for the same video. WEB/TV often return only signatureCipher'd URLs
 * (which need player-JS deciphering — yt-dlp's job, not ours), so clients
 * whose formats are all ciphered are skipped in favour of the next client.
 *
 * Returns null only when every client fails without a definitive verdict
 * (caller reports). Throws user-facing errors (❌…) for definitive failures
 * (too large). Bot-wall / gone errors are thrown as plain text so youtube.ts
 * can classify them (bot-wall vs gone) for the final message.
 */
export async function downloadYouTubeViaAndroid(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  const failures: string[] = [];
  for (const client of YOUTUBEI_CLIENTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.publicApiTimeoutMs);
    let data: YoutubeiResponse;
    try {
      const headers: Record<string, string> = {
        "User-Agent": client.userAgent,
        "Content-Type": "application/json",
      };
      if (client.origin) headers.Origin = client.origin;
      const res = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${KEY}&prettyPrint=false`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
          context: client.context,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Release the socket for a body we are not going to read.
        try {
          await res.body?.cancel();
        } catch {}
        throw new Error(`youtubei HTTP ${res.status}`);
      }
      // Cap the player response before parsing: it is remote input, and a
      // broken/oversized body must not be buffered whole into this small host.
      data = JSON.parse(await readBodyCapped(res, 4 * 1024 * 1024)) as YoutubeiResponse;
    } catch (err: any) {
      clearTimeout(timeout);
      const msg = err?.name === "AbortError" ? "timed out" : (err?.message || String(err));
      console.warn(`⚠️ Youtubei ${client.name}: ${videoId} request failed: ${String(msg).slice(0, 110)}`);
      failures.push(`${client.name}: ${String(msg).slice(0, 80)}`);
      continue;
    } finally {
      clearTimeout(timeout);
    }

    const status = data?.playabilityStatus?.status;
    if (status !== "OK") {
      const reason = (data?.playabilityStatus?.reason || status || "unplayable").slice(0, 120);
      console.warn(`⚠️ Youtubei ${client.name}: ${videoId} -> ${status}: ${reason}`);
      failures.push(`${client.name}: ${status}`);
      // LOGIN_REQUIRED / wall on one client doesn't mean the next is walled —
      // keep rotating. Only stop early when the video itself is confirmed gone
      // on a client that answered decisively AND no client has succeeded.
      // (Final classification happens in youtube.ts.)
      continue;
    }

    const formats = data?.streamingData?.formats || [];
    const ranked = pickProgressiveSorted(formats, config.youtubeMaxHeight);
    if (ranked.length === 0 || !ranked[0]?.url) {
      console.warn(`⚠️ Youtubei ${client.name}: ${videoId} OK but no direct progressive mp4 (all ciphered?) — trying next client…`);
      failures.push(`${client.name}: ciphered-only`);
      continue;
    }

    const title = data?.videoDetails?.title || videoId;
    if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
    const id = crypto.randomBytes(6).toString("hex");

    // Walk renditions best-first so an over-limit file retries lower quality
    // on the same client before moving to the next client identity.
    let saved: DownloadResult | null = null;
    // Set when THIS client's stream URL failed (expired/403/CDN reset). A
    // stream failure says nothing about the other player clients, so it must
    // not abort the rotation — rotating clients is exactly what this method
    // is for.
    let streamFailed = false;
    for (const chosen of ranked) {
      if (!chosen?.url) continue;
      console.log(`⚡ Youtubei ${client.name}: "${title.slice(0, 60)}" -> itag ${chosen.itag} (${chosen.height || "?"}p) progressive MP4`);
      const fileName = `${id}_${sanitizeFileName(title)}.mp4`;
      const filePath = path.join(config.downloadDir, fileName);
      try {
        await streamToFile(chosen.url, filePath, client.userAgent, onProgress);
      } catch (err: any) {
        if (err instanceof TooLargeError) {
          console.log(`⚡ Youtubei ${client.name}: ${chosen.height || "?"}p over limit, trying lower quality…`);
          continue;
        }
        console.warn(`⚠️ Youtubei ${client.name}: ${videoId} stream failed: ${String(err?.message || err).slice(0, 110)}`);
        failures.push(`${client.name}: stream failed`);
        streamFailed = true;
        break;
      }
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
        console.warn(`⚠️ Youtubei ${client.name}: ${videoId} saved an empty file — trying next client…`);
        failures.push(`${client.name}: empty file`);
        streamFailed = true;
        break;
      }
      console.log(`✅ Youtubei ${client.name} saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
      saved = { filePath, fileName, title, ext: "mp4", size: stat.size, platform: "youtube" };
      break;
    }
    if (saved) return saved;
    if (streamFailed) continue;
    // Every rendition on this client overflowed the Telegram limit — the cap
    // is the same for every client, so this is definitive for the video.
    throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
  }

  // Every client failed — surface the combined verdict so youtube.ts can
  // classify it. Prefer a LOGIN_REQUIRED/wall sample when present (it means
  // "walled", not "gone"), else the last failure.
  const wallSample = failures.find((f) => /LOGIN_REQUIRED|not a bot|confirm you|HTTP 429|Too Many|unplayable|ERROR/i.test(f));
  throw new Error(wallSample || failures[failures.length - 1] || "youtubei: all clients failed");
}
