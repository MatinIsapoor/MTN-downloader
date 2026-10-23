import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { once } from "events";
import { config } from "../config";
import { TooLargeError } from "./quality";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export function isCobaltConfigured(): boolean {
  return config.cobaltApiUrl.length > 0;
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

interface CobaltResponse {
  status?: string;
  url?: string;
  filename?: string;
  picker?: Array<{ url?: string; type?: string }>;
  error?: { code?: string };
}

/** Stream a remote file to disk with max-size enforcement + progress. */
async function streamToFile(
  fileUrl: string,
  filePath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": UA },
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
    // TooLargeError (not a plain ❌ Error) so the caller can retry a lower
    // quality instead of treating the very first rendition as definitive.
    if (total > maxBytes) {
      try {
        await body.cancel();
      } catch {}
      throw new TooLargeError(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
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
          // the caller treat "retry a lower quality" as a hard failure.
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
      throw new TooLargeError(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
    }
  } catch (err: any) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {}
    if (err instanceof TooLargeError) throw err;
    // NOTE: no ❌ prefix — callers treat ❌ as a definitive verdict on the
    // video. A slow/aborted tunnel download is only this provider failing,
    // so the next method must still get a chance.
    if (err?.name === "AbortError") throw new Error("Download timed out (video server too slow or blocked).");
    throw err instanceof Error ? err : new Error(`❌ Download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/** Cobalt's fixed `videoQuality` buckets (it has no uncapped numeric value). */
const COBALT_BUCKETS = [144, 240, 360, 480, 720, 1080, 1440, 2160];

/**
 * Map the configured height cap DOWN to the best Cobalt bucket at/under it.
 * The old inline ternary rounded 0 (= uncapped), 240 and 360 all up to "480",
 * so the bot could request a rendition ABOVE the configured cap (and an
 * uncapped config silently forced 480p).
 */
function cobaltQualityBucket(maxHeight: number): number {
  if (maxHeight <= 0) return COBALT_BUCKETS[COBALT_BUCKETS.length - 1];
  const fitting = COBALT_BUCKETS.filter((h) => h <= maxHeight);
  return fitting.length > 0 ? fitting[fitting.length - 1] : COBALT_BUCKETS[0];
}

/**
 * Qualities to try, best-first. Cobalt resolves exactly ONE quality per
 * request, so an over-limit file retries the next lower bucket — the same
 * ladder the Invidious/Piped/youtubei paths already have. Without it a 720p
 * file over Telegram's limit aborted the whole pipeline instead of falling
 * back to 480p. Cobalt ignores videoQuality for non-YouTube services, so
 * those get a single attempt (re-asking would just re-download the same
 * oversized file).
 */
function cobaltQualityLadder(platform: string, maxHeight: number): number[] {
  const top = cobaltQualityBucket(maxHeight);
  if (platform !== "youtube") return [top];
  const lower = COBALT_BUCKETS.filter((h) => h < top).reverse();
  return [top, ...lower].slice(0, 3);
}

interface CobaltResolved {
  fileUrl: string;
  filename?: string;
}

/**
 * Resolve `url` at one quality through the Cobalt API.
 * Returns null when the attempt is inconclusive (API down, timeout, unknown
 * status) so the caller can fall back, and throws ❌ for definitive failures
 * (content gone/private).
 */
async function resolveCobalt(url: string, quality: number): Promise<CobaltResolved | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let data: CobaltResponse;
  try {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": UA,
    };
    if (config.cobaltApiKey) headers.Authorization = `Api-Key ${config.cobaltApiKey}`;
    const res = await fetch(config.cobaltApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        url,
        videoQuality: String(quality),
        downloadMode: "auto",
        filenameStyle: "basic",
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      // Release the socket for a body we are not going to read.
      try {
        await res.body?.cancel();
      } catch {}
      throw new Error(`Cobalt API HTTP ${res.status}`);
    }
    data = (await res.json()) as CobaltResponse;
  } catch (err: any) {
    if (err?.name === "AbortError") {
      console.warn("⚠️ Cobalt API timed out, falling back…");
      return null;
    }
    console.warn(`⚠️ Cobalt API failed: ${(err?.message || String(err)).slice(0, 130)} — falling back…`);
    return null;
  } finally {
    clearTimeout(timeout);
  }

  if (data?.error) {
    const code = String(data.error?.code || "error");
    console.warn(`⚠️ Cobalt error: ${code} — falling back…`);
    // Definitive: content itself is gone.
    if (/not[._]?found|private|deleted|unavailable|no_results/i.test(code)) {
      throw new Error("❌ Video unavailable or private.");
    }
    return null;
  }

  let fileUrl: string | undefined = typeof data?.url === "string" ? data.url : undefined;
  if (!fileUrl && Array.isArray(data?.picker)) {
    // A picker response carries separate entries (video + audio): blindly
    // taking the first one can save the AUDIO track as a bogus .mp4.
    fileUrl =
      data.picker.find((p) => p?.type === "video" && p?.url)?.url ||
      data.picker.find((p) => p?.url)?.url;
  }
  if (!fileUrl) {
    console.warn(`⚠️ Cobalt returned status=${data?.status || "?"} with no URL — falling back…`);
    return null;
  }
  // The download URL comes from the instance payload, so validate it before
  // fetch() ever sees it: only http(s) is legitimate here (SSRF guard — a
  // misbehaving instance must not be able to hand us file:/data:/etc.).
  let parsed: URL;
  try {
    parsed = new URL(fileUrl);
  } catch {
    console.warn("⚠️ Cobalt returned an unparseable download URL — falling back…");
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    console.warn(`⚠️ Cobalt returned a non-HTTP download URL (${parsed.protocol}) — falling back…`);
    return null;
  }

  console.log(`⚡ Cobalt resolved (${data.status || "tunnel"}, ${quality}p), downloading direct MP4…`);
  return { fileUrl, filename: data.filename };
}

/**
 * Cobalt API path (optional, all platforms).
 *
 * Needs a SELF-HOSTED instance (COBALT_API_URL) — the public cobalt.tools
 * instance is blocked for YouTube since 2025, so there is no usable default.
 * When configured, Cobalt resolves the URL into a direct tunnel/redirect MP4
 * (single file, no ffmpeg merge = fast) and we stream it with plain HTTPS.
 *
 * API: POST {instance}/ with {url, videoQuality, downloadMode, filenameStyle}
 * (imputnet/cobalt v10+). Auth: `Authorization: Api-Key <key>` when set.
 *
 * Returns null when Cobalt can't resolve (caller falls back to next method).
 * Throws user-facing errors (❌…) for definitive failures.
 */
export async function downloadViaCobalt(
  url: string,
  platform: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  if (!isCobaltConfigured()) return null;

  const qualities = cobaltQualityLadder(platform, config.youtubeMaxHeight);
  const id = crypto.randomBytes(6).toString("hex");
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

  for (let i = 0; i < qualities.length; i++) {
    const quality = qualities[i];
    const resolved = await resolveCobalt(url, quality);
    if (!resolved) return null;

    const base = sanitizeFileName(resolved.filename?.replace(/\.[a-z0-9]+$/i, "") || platform);
    const fileName = `${id}_${base}.mp4`;
    const filePath = path.join(config.downloadDir, fileName);
    try {
      await streamToFile(resolved.fileUrl, filePath, onProgress);
    } catch (err: any) {
      // Over Telegram's limit → retry the next lower bucket (if any), the
      // same behavior the other providers have.
      if (err instanceof TooLargeError && i < qualities.length - 1) {
        console.log(`⚡ Cobalt: ${quality}p over limit, trying lower quality…`);
        continue;
      }
      throw err;
    }
    const stat = fs.statSync(filePath);
    if (stat.size === 0) {
      try {
        fs.unlinkSync(filePath);
      } catch {}
      throw new Error("❌ Download returned an empty file. Try another link.");
    }
    console.log(`✅ Cobalt saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
    return { filePath, fileName, ext: "mp4", size: stat.size, platform };
  }
  // Unreachable (the last quality either returns or throws), kept for types.
  throw new TooLargeError(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
}
