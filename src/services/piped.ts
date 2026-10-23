import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { once } from "events";
import { config } from "../config";
import { extractYouTubeId, readBodyCapped, assertSafeMediaUrl } from "./invidious";
import { TooLargeError } from "./quality";
import type { DownloadProgress, DownloadResult } from "./downloader";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface PipedVideoStream {
  url?: string;
  quality?: string;
  mimeType?: string;
  codec?: string;
  videoOnly?: boolean;
  container?: string;
  height?: number;
  width?: number;
}

interface PipedResponse {
  title?: string;
  videoStreams?: PipedVideoStream[];
  audioStreams?: unknown[];
  error?: string;
}

function parseHeight(s: PipedVideoStream): number {
  if (typeof s.height === "number" && s.height > 0) return s.height;
  const q = s.quality || "";
  const m = q.match(/(\d+)\s*p/i);
  return m ? Number(m[1]) : 0;
}

function isProgressiveMp4(s: PipedVideoStream): boolean {
  if (!s.url) return false;
  if (s.videoOnly === true) return false;
  const mime = (s.mimeType || "").toLowerCase();
  const container = (s.container || "").toLowerCase();
  if (container === "mp4") return true;
  if (mime.includes("video/mp4")) return true;
  return false;
}

/** Best progressive (audio+video) MP4 at or under maxHeight (0 = uncapped). */
export function pickPipedStream(
  streams: PipedVideoStream[],
  maxHeight: number
): PipedVideoStream | null {
  return pickPipedStreamsSorted(streams, maxHeight)[0] || null;
}

/**
 * All progressive MP4s sorted best-first (at/under cap first, then smaller
 * fallbacks). The downloader walks this list so an over-limit rendition
 * retries the next lower one instead of failing the whole video.
 */
export function pickPipedStreamsSorted(
  streams: PipedVideoStream[],
  maxHeight: number
): PipedVideoStream[] {
  const mp4s = streams.filter(isProgressiveMp4);
  if (mp4s.length === 0) return [];
  const withHeight = mp4s.map((s) => ({ s, h: parseHeight(s) }));
  const known = withHeight.filter((x) => x.h > 0).sort((a, b) => b.h - a.h);
  const unknown = withHeight.filter((x) => x.h <= 0).map((x) => x.s);
  if (maxHeight > 0) {
    const fitting = known.filter((x) => x.h <= maxHeight).map((x) => x.s);
    const smaller = known.filter((x) => x.h > maxHeight).sort((a, b) => a.h - b.h).map((x) => x.s);
    // Best fit first, then progressively smaller (over-cap ones last resort).
    if (fitting.length > 0) return [...fitting, ...unknown, ...smaller];
    return [...known.sort((a, b) => a.h - b.h).map((x) => x.s), ...unknown];
  }
  return [...known.map((x) => x.s), ...unknown];
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

async function streamToFile(
  fileUrl: string,
  filePath: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<number> {
  // SSRF guard: the URL comes from the backend's JSON payload.
  assertSafeMediaUrl(fileUrl);
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
 * Live backend discovery: the official Piped docs repo lists every known
 * public instance. Public backends die regularly (verified Sep 2026: 10 of
 * 17 known hosts dead), so merge the live list behind the configured one —
 * the bot self-heals without a redeploy when instances rotate.
 * Cached per process (6h); never throws (falls back to configured list).
 */
let _pipedCache: { at: number; list: string[] } | null = null;
async function resolvePipedInstances(): Promise<string[]> {
  const configured = config.pipedInstances;
  if (!config.pipedRefresh) return configured;
  const now = Date.now();
  if (_pipedCache && now - _pipedCache.at < 6 * 3600 * 1000) return _pipedCache.list;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let md = "";
    try {
      const res = await fetch(
        "https://raw.githubusercontent.com/TeamPiped/documentation/main/content/docs/public-instances/index.md",
        { headers: { "User-Agent": UA }, signal: controller.signal }
      );
      if (!res.ok) {
        // Release the socket for a body we are not going to read.
        try {
          await res.body?.cancel();
        } catch {}
        throw new Error(`HTTP ${res.status}`);
      }
      // This is a GitHub-hosted markdown file we only regex for hostnames, so
      // there is no reason to buffer an unbounded response in RAM.
      md = await readBodyCapped(res, 2 * 1024 * 1024);
    } finally {
      clearTimeout(timeout);
    }
    const discovered = [...new Set(
      [...md.matchAll(/https:\/\/[A-Za-z0-9.-]+/g)]
        .map((m) => m[0].replace(/\/+$/, ""))
        // Backend API hosts only. The docs page also lists frontend websites
        // (piped.video, …) and other links; those answer 404 on
        // /streams/{id}, and one of them slipping into the rotation both
        // wasted a slot and could trigger the "video gone" early stop. API
        // hosts are named pipedapi… / api.piped… / piped-api… / api-piped….
        .filter((u) => /pipedapi|api\.piped|piped-api|api-piped/i.test(u))
    )];
    const merged = [...new Set([...configured, ...discovered])];
    if (merged.length > 0) {
      _pipedCache = { at: now, list: merged.slice(0, 20) };
      if (discovered.length > 0) {
        console.log(`⚡ Piped: live discovery added ${discovered.length} known backends (${merged.length} total to try)`);
      }
      return _pipedCache.list;
    }
  } catch (err: any) {
    console.warn(`⚠️ Piped instance refresh failed, using configured list: ${(err?.message || String(err)).slice(0, 100)}`);
  }
  return configured;
}

/** Classified failure counts from the last Piped attempt (for smart errors). */
export interface PipedSummary {
  tried: number;
  /** backend reachable but YouTube bot-walled it for this video (HTTP 500 w/ SignInConfirmNotBot, 429, proxy 502/403) */
  botWalled: number;
  /** video itself looks gone/private (backend says unavailable/deleted/private, or no streams on a healthy backend) */
  notFound: number;
  /** backend dead/unreachable (DNS, timeout, connection refused) */
  unreachable: number;
  other: number;
}

let _lastSummary: PipedSummary = { tried: 0, botWalled: 0, notFound: 0, unreachable: 0, other: 0 };
export function getLastPipedSummary(): PipedSummary {
  return { ..._lastSummary };
}

/** True when a failure message PROVES the video itself is gone/private. */
function isVideoGone(msg: string): boolean {
  return /unavailable|private|deleted|NOT_FOUND|privateVideo|age[- ]?(?:restricted|gated)|requires login/i.test(msg);
}

function classifyPipedError(msg: string): keyof Omit<PipedSummary, "tried"> {
  // Definitive "the video is gone" verdicts come FIRST: a 404/410 from
  // /streams/{id} means this backend does not have that video, so treating it
  // as a transient failure was wrong — it made every not-found video pay a
  // pointless delayed retry pass, and left the notFound counter at zero so the
  // user got "unreachable" advice instead of "private/deleted".
  // NOTE: the old regex also matched the bare word "age" — and "message"
  // contains it — so ordinary errors were misclassified as "video gone".
  //
  // "no progressive mp4 stream" lands here too (the video may be perfectly
  // fine but this backend only exposes DASH tracks) — the caller only stops
  // the rotation on a message that isVideoGone() confirms.
  if (
    /HTTP 404|HTTP 410|unavailable|private|deleted|login-walled or gone|no progressive mp4 stream|no mp4 stream|NOT_FOUND|privateVideo|age[- ]?(?:restricted|gated)|requires login/i.test(
      msg
    )
  ) {
    return "notFound";
  }
  // Reachable, but not for this video right now: rate-limit / bot-wall / edge
  // proxy. HTTP 500/502/503/504 from a backend usually means its upstream
  // YouTube call was walled (or Cloudflare is in front of it).
  if (
    /SignInConfirmNotBot|temporarily blocked|HTTP 429|Too Many Requests|HTTP 50[0234]|Bad Gateway|HTTP 403|Forbidden|blocked by administrative|Just a moment|Authorization Required/i.test(
      msg
    )
  ) {
    return "botWalled";
  }
  // DNS / connect / abort failures: the backend itself is dead from here.
  if (
    /fetch failed|timeout|timed out|AbortError|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|EHOSTUNREACH|ECONNRESET|UND_ERR|network is unreachable/i.test(
      msg
    )
  ) {
    return "unreachable";
  }
  return "other";
}

async function tryPipedInstance(
  instance: string,
  videoId: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.publicApiTimeoutMs);
  try {
    const res = await fetch(`${instance}/streams/${videoId}`, {
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
    // Public instance payload: cap it (see readBodyCapped) instead of
    // buffering whatever the host decides to send.
    const data = JSON.parse(await readBodyCapped(res, 4 * 1024 * 1024)) as PipedResponse;
    if (data?.error) throw new Error(String(data.error).slice(0, 160));
    const streams = Array.isArray(data?.videoStreams) ? data.videoStreams! : [];
    const ranked = pickPipedStreamsSorted(streams, config.youtubeMaxHeight);
    if (ranked.length === 0 || !ranked[0]?.url) {
      throw new Error("no progressive mp4 stream (login-walled or gone?)");
    }

    const id = crypto.randomBytes(6).toString("hex");
    if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

    // Walk renditions best-first: an over-limit file retries the next lower
    // quality on the SAME backend instead of failing the whole video.
    for (const chosen of ranked) {
      const height = parseHeight(chosen);
      const fileName = `${id}_${sanitizeFileName(data.title || videoId)}.mp4`;
      const filePath = path.join(config.downloadDir, fileName);
      try {
        console.log(
          `⚡ Piped ${instance}: "${(data.title || videoId).slice(0, 60)}" ` +
            `-> ${chosen.quality || (height ? height + "p" : "mp4")} progressive MP4`
        );
        await streamToFile(chosen.url!, filePath, onProgress);
      } catch (err: any) {
        if (err instanceof TooLargeError) {
          console.log(`⚡ Piped ${instance}: ${height || "?"}p over limit, trying lower quality…`);
          continue;
        }
        throw err;
      }
      const stat = fs.statSync(filePath);
      if (stat.size === 0) {
        try { fs.unlinkSync(filePath); } catch {}
        throw new Error("empty file");
      }
      console.log(`✅ Piped saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
      return { filePath, fileName, title: data.title, ext: "mp4", size: stat.size, platform: "youtube" };
    }
    // Every rendition overflowed the Telegram limit — definitive for this video.
    throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Cookie-free YouTube path: Piped API.
 *
 * Each public Piped backend instance proxies YouTube on its own IP, so this
 * bypasses datacenter "Sign in to confirm you're not a bot" walls —
 * plain HTTPS, no yt-dlp binary, no cookies, and the result is a single
 * progressive MP4 served through the instance's proxy (no ffmpeg merge).
 *
 * YouTube bot-walls backend IPs *per video*, so we rotate through every
 * known backend, then — when failures look transient (bot-wall, not
 * video-gone) — wait a few seconds and retry the backends that actually
 * answered, since the wall is often momentary.
 *
 * API: GET {instance}/streams/{videoId}
 *   -> { title, videoStreams: [{url, quality, mimeType, videoOnly, ...}] }
 *
 * Returns null when every instance fails (caller tries the next method).
 * Throws user-facing errors (❌…) for definitive failures (too large).
 */
export async function downloadYouTubeViaPiped(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  const videoId = extractYouTubeId(url);
  if (!videoId) return null;

  const allInstances = await resolvePipedInstances();
  // Cap the rotation: public backends die constantly and each dead host
  // costs a full timeout. First 12 (verified-alive first) is plenty —
  // beyond that we burn minutes for almost zero extra hit rate.
  const instances = allInstances.slice(0, 12);
  const summary: PipedSummary = { tried: 0, botWalled: 0, notFound: 0, unreachable: 0, other: 0 };
  const failures: string[] = [];
  const answered: string[] = []; // transient failures on a reachable backend (worth a retry)
  // Set only when a backend explicitly says the VIDEO is gone/private — that,
  // and not the broader "notFound" bucket, is what justifies stopping early.
  let videoGone = false;

  const attempt = async (instance: string): Promise<DownloadResult | null> => {
    summary.tried++;
    try {
      return await tryPipedInstance(instance, videoId, onProgress);
    } catch (err: any) {
      if (err instanceof TooLargeError) throw err; // handled per-rendition; all overflowed → definitive
      const msg = err?.message || String(err);
      if (msg.startsWith("❌")) throw err; // definitive (too large) — stop everything
      const kind = classifyPipedError(msg);
      summary[kind]++;
      if (kind === "notFound" && isVideoGone(msg)) videoGone = true;
      // Only transient failures are worth retrying: retrying a backend that
      // said "video gone" (or "no progressive stream") is pure wasted time.
      if (kind === "botWalled" || kind === "other") answered.push(instance);
      console.warn(`⚠️ Piped ${instance} failed for ${videoId}: ${msg.slice(0, 130)}`);
      failures.push(`${instance}: ${msg.slice(0, 80)}`);
      return null;
    }
  };

  // Pass 1: rotate through every known backend.
  for (const instance of instances) {
    const hit = await attempt(instance);
    if (hit) {
      _lastSummary = summary;
      return hit;
    }
    // The VIDEO itself is gone (backend explicitly says unavailable/private/
    // deleted) — other backends will say the same, stop early. A backend that
    // merely had no progressive mp4 stream must NOT stop the rotation: another
    // instance usually proxies the same video fine, and stopping there made
    // the whole Piped path fail for videos the first backend couldn't serve.
    if (videoGone) break;
  }

  // Pass 2: transient bot-walls often clear within seconds — retry the
  // backends that answered (skip DNS-dead ones), once, after a short pause.
  const transient = summary.botWalled + summary.other;
  if (transient > 0 && !videoGone) {
    const retryList = [...new Set(answered)].slice(0, 4);
    if (retryList.length > 0) {
      console.log(`⚡ Piped: ${transient} transient failure(s), retrying ${retryList.length} answering backend(s) in 3s…`);
      await new Promise((r) => setTimeout(r, 3000));
      for (const instance of retryList) {
        const hit = await attempt(instance);
        if (hit) {
          _lastSummary = summary;
          return hit;
        }
      }
    }
  }

  _lastSummary = summary;
  console.warn(`⚠️ All Piped instances failed: ${failures.join(" | ").slice(0, 300)}`);
  return null;
}
