import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { once } from "events";
import { config } from "../config";
import { TooLargeError } from "./quality";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Extract the 11-char YouTube video ID from any common URL form. */
export function extractYouTubeId(url: string): string | null {
  const candidates = [url.trim()];
  // Attribution / share links embed an encoded watch URL (u=/watch%3Fv%3D…):
  // decode once so the normal patterns below can match it.
  try {
    const decoded = decodeURIComponent(url.trim());
    if (decoded !== url.trim()) candidates.push(decoded);
  } catch {}
  for (const candidate of candidates) {
    const id = extractYouTubeIdFromPlain(candidate);
    if (id) return id;
  }
  return null;
}

function extractYouTubeIdFromPlain(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return /^[A-Za-z0-9_-]{11}$/.test(id || "") ? id! : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      // /watch?v=ID
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      // /shorts/ID, /embed/ID, /live/ID, /v/ID, /short/ID
      const m = u.pathname.match(/\/(?:shorts|embed|live|v|short)\/([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
      if (m) return m[1];
    }
  } catch {}
  // Tight fallback: the token must look like a video reference (v= param or
  // /path/ segment with a delimiter after it) — never an arbitrary 11-char
  // run, which misfires on playlist IDs (?list=PL…) and channel handles
  // (/@SomeChannel) and sends every provider chasing a garbage ID.
  // Only for URLs that are actually YouTube links.
  if (!/(?:youtube|youtu\.be)/i.test(url)) return null;
  const m = url.match(/(?:[?&#/]v=|\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m ? m[1] : null;
}

interface InvidiousFormat {
  url?: string;
  itag?: string;
  type?: string;
  container?: string;
  qualityLabel?: string;
  resolution?: string;
  size?: string;
  encoding?: string;
}

function parseHeight(f: InvidiousFormat): number {
  const label = f.qualityLabel || f.resolution || "";
  const m = label.match(/(\d+)\s*p/i);
  if (m) return Number(m[1]);
  return 0;
}

function isMp4Progressive(f: InvidiousFormat): boolean {
  if (!f.url) return false;
  const t = (f.type || "").toLowerCase();
  const c = (f.container || "").toLowerCase();
  if (c === "mp4") return true;
  // type looks like 'video/mp4; codecs="avc1..., mp4a..."' for muxed streams.
  if (t.includes("video/mp4")) return true;
  return false;
}

/** Pick the best progressive MP4 at or under maxHeight (0 = uncapped). */
export function pickFormat(
  formats: InvidiousFormat[],
  maxHeight: number
): InvidiousFormat | null {
  return pickFormatsSorted(formats, maxHeight)[0] || null;
}

/**
 * All progressive MP4s sorted best-first (at/under cap first, then smaller
 * fallbacks). Walked in order so an over-limit rendition retries lower.
 */
export function pickFormatsSorted(
  formats: InvidiousFormat[],
  maxHeight: number
): InvidiousFormat[] {
  const mp4s = formats.filter(isMp4Progressive);
  if (mp4s.length === 0) return [];
  const withHeight = mp4s.map((f) => ({ f, h: parseHeight(f) }));
  const known = withHeight.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
  const unknown = withHeight.filter((x) => x.h <= 0).map((x) => x.f);
  if (maxHeight > 0) {
    const fitting = known.filter((x) => x.h <= maxHeight).map((x) => x.f);
    const smaller = known.filter((x) => x.h > maxHeight).sort((a, b) => a.h - b.h).map((x) => x.f);
    if (fitting.length > 0) return [...fitting, ...unknown, ...smaller];
    return [...known.sort((a, b) => a.h - b.h).map((x) => x.f), ...unknown];
  }
  return [...known.map((x) => x.f), ...unknown];
}

/** Cap for JSON metadata bodies. Instance APIs answer in the low hundreds of KB. */
const MAX_API_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Read a response body as UTF-8 text with a hard byte cap.
 *
 * The public instances we talk to are untrusted third parties: a broken (or
 * hostile) instance can stream an unbounded body — or a huge HTML error page
 * where JSON was promised — and the old `res.json()` buffered ALL of it in
 * RAM before parsing. On a ~512MB host that is an easy OOM. Crossing the cap
 * cancels the body so the socket is released instead of draining forever.
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) throw new Error("empty response body");
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    received += chunk.length;
    if (received > maxBytes) {
      try {
        await body.cancel();
      } catch {}
      throw new Error(`response too large (>${Math.round(maxBytes / 1024)}KB)`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchJsonWithTimeout(url: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) {
      // Release the socket for a body we are not going to read.
      try {
        await res.body?.cancel();
      } catch {}
      throw new Error(`HTTP ${res.status}`);
    }
    const text = await readBodyCapped(res, MAX_API_BODY_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      // HTML challenge pages / truncated bodies land here — give the caller a
      // clear cause instead of a raw SyntaxError about an unexpected "<".
      throw new Error("invalid JSON response");
    }
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Live instance discovery: api.invidious.io/instances.json lists every known
 * instance with health + api flag. Public instances increasingly disable the
 * API (HTTP 403 on /api/v1/*), so prefer api-enabled, healthy instances.
 * Cached per process; never throws (falls back to configured list).
 */
let _instanceCache: { at: number; list: string[] } | null = null;
async function resolveInstances(): Promise<string[]> {
  const configured = config.invidiousInstances;
  if (!config.invidiousRefresh) return configured;
  const now = Date.now();
  if (_instanceCache && now - _instanceCache.at < 6 * 3600 * 1000) return _instanceCache.list;
  try {
    const data = await fetchJsonWithTimeout("https://api.invidious.io/instances.json", 10000);
    // Format: [[domain, {uri, api, monitor...}], ...]
    const rows: Array<[string, any]> = Array.isArray(data) ? data : [];
    const healthy = rows
      .map(([_, info]) => ({
        uri: String(info?.uri || "").replace(/\/+$/, ""),
        api: info?.api === true,
        health: Number(info?.monitor?.statusClass === "success" ? 1 : 0),
      }))
      .filter((x) => x.uri.startsWith("https://"));
    // `monitor.statusClass` was parsed into `health` but never used, so an
    // offline instance could stay ahead of a live one in the rotation. Prefer
    // healthy instances within each group; unknown health (missing monitor
    // data) simply sorts last instead of being dropped.
    const apiOn = healthy.filter((x) => x.api).sort((a, b) => b.health - a.health).map((x) => x.uri);
    const apiOff = healthy.filter((x) => !x.api).sort((a, b) => b.health - a.health).map((x) => x.uri);
    // Merge: live api-enabled first, then configured (may overlap), then rest.
    const merged = [...new Set([...apiOn, ...configured, ...apiOff])];
    if (merged.length > 0) {
      _instanceCache = { at: now, list: merged.slice(0, 12) };
      if (apiOn.length !== merged.length) {
        console.log(`⚡ Invidious: live discovery found ${apiOn.length} api-enabled instances of ${merged.length} total`);
      }
      return _instanceCache.list;
    }
  } catch (err: any) {
    console.warn(`⚠️ Invidious instance refresh failed, using configured list: ${(err?.message || String(err)).slice(0, 100)}`);
  }
  return configured;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

/**
 * Guard a provider-supplied media URL before the bot fetches it.
 *
 * The MP4 URL comes from a public third-party instance's JSON (not from the
 * user), so a broken or malicious instance could point the bot at the cloud
 * metadata service (169.254.169.254), a localhost admin port or an internal
 * hostname and make the server fetch it — a classic SSRF. fetch() only speaks
 * http(s), but the HOST also has to be public, so reject the literal internal
 * forms below. (A full fix needs an egress firewall; every legitimate CDN host
 * passes this check unchanged.)
 */
export function assertSafeMediaUrl(mediaUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(mediaUrl);
  } catch {
    throw new Error("provider returned an invalid media URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`provider returned a non-HTTP media URL (${parsed.protocol})`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpv6 = host.includes(":");
  const internal =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    /^(?:0|127)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    (isIpv6 &&
      (host === "::1" ||
        host.startsWith("fe80:") ||
        /^f[cd]/.test(host) ||
        host.startsWith("::ffff:")));
  if (internal) throw new Error(`provider returned an internal media URL (${host})`);
}

/** Stream a remote file to disk with Telegram max-size enforcement + progress. */
async function streamToFile(
  fileUrl: string,
  filePath: string,
  referer: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<number> {
  // SSRF guard: the URL comes from the instance's JSON payload.
  assertSafeMediaUrl(fileUrl);
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": UA, Referer: referer },
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
    return received;
  } catch (err: any) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    if (err instanceof TooLargeError) throw err;
    // NOTE: no ❌ prefix — callers treat ❌ as "the video itself is
    // unwinnable". A slow/aborted media host is only THIS provider failing,
    // so the pipeline must be allowed to continue with the next method.
    if (err?.name === "AbortError") throw new Error("Download timed out (video server too slow or blocked).");
    throw err instanceof Error ? err : new Error(`❌ Download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Fast YouTube path: resolve the progressive MP4 through a public Invidious
 * instance and download it with plain HTTPS.
 *
 * Why this is faster + more reliable than yt-dlp for YouTube:
 * - The instance (not our datacenter IP) talks to YouTube, so Render's
 *   IP-based "Sign in to confirm you're not a bot" checks don't apply.
 * - No JS-challenge solving, no cookies, no player-client roulette.
 * - The result is a single muxed MP4 — no DASH video+audio merge via ffmpeg,
 *   which is the slowest part of the yt-dlp path on small hosts.
 *
 * Returns null when every instance fails (caller falls back to yt-dlp).
 * Throws user-facing errors (❌…) for definitive failures (too large, gone).
 */
export async function downloadYouTubeViaInvidious(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  // Cap the rotation: most public instances disabled their API (HTTP 403).
  // First 8 keeps the fallback quick instead of stalling on dead hosts.
  const allInstances = await resolveInstances();
  const instances = allInstances.slice(0, 8);
  const failures: string[] = [];
  let apiDisabledCount = 0;
  for (const instance of instances) {
    try {
      const data = await fetchJsonWithTimeout(
        `${instance}/api/v1/videos/${videoId}`,
        config.publicApiTimeoutMs
      );
      if (data?.error) throw new Error(String(data.error).slice(0, 120));
      const title: string | undefined = data?.title;
      const formats: InvidiousFormat[] = data?.formatStreams || [];
      if (!Array.isArray(formats) || formats.length === 0) {
        throw new Error("no progressive streams (login-walled or gone?)");
      }
      const ranked = pickFormatsSorted(formats, config.youtubeMaxHeight);
      if (ranked.length === 0 || !ranked[0]?.url) throw new Error("no mp4 stream available");

      if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
      const id = crypto.randomBytes(6).toString("hex");

      // Walk renditions best-first: over-limit files retry lower quality.
      let completed: DownloadResult | null = null;
      for (const chosen of ranked) {
        if (!chosen?.url) continue;
        const height = parseHeight(chosen);
        console.log(
          `⚡ Invidious ${instance}: "${(title || videoId).slice(0, 60)}" ` +
            `-> ${chosen.qualityLabel || height + "p" || "mp4"} progressive MP4`
        );
        const fileName = `${id}_${sanitizeFileName(title || videoId)}.mp4`;
        const filePath = path.join(config.downloadDir, fileName);
        try {
          await streamToFile(chosen.url, filePath, `${instance}/`, onProgress);
        } catch (err: any) {
          if (err instanceof TooLargeError) {
            console.log(`⚡ Invidious ${instance}: ${height || "?"}p over limit, trying lower quality…`);
            continue;
          }
          throw err;
        }
        const stat = fs.statSync(filePath);
        if (stat.size === 0) {
          try {
            fs.unlinkSync(filePath);
          } catch {}
          throw new Error("empty file");
        }
        console.log(`✅ Invidious saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
        completed = {
          filePath,
          fileName,
          title,
          ext: "mp4",
          size: stat.size,
          platform: "youtube",
        };
        break;
      }
      if (completed) return completed;
      throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Definitive failures: don't burn through every instance.
      if (msg.startsWith("❌")) throw err;
      // HTTP 403 on /api/v1/* almost always means the instance disabled its
      // public API (the 2026 norm — api=false on api.invidious.io), NOT that
      // the video is gone. Count it separately for a clearer summary.
      if (/HTTP 403/.test(msg)) apiDisabledCount++;
      console.warn(`⚠️ Invidious ${instance} failed for ${videoId}: ${msg.slice(0, 130)}`);
      failures.push(`${instance}: ${msg.slice(0, 80)}`);
    }
  }
  if (apiDisabledCount === instances.length && instances.length > 0) {
    console.warn(
      `⚠️ All ${instances.length} Invidious instances refused the API (HTTP 403 = public API disabled, the 2026 norm). ` +
        `Falling back to yt-dlp; self-hosting Invidious/Cobalt restores the fast path.`
    );
  } else {
    console.warn(`⚠️ All Invidious instances failed: ${failures.join(" | ").slice(0, 300)}`);
  }
  return null;
}
