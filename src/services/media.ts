import { spawn } from "child_process";
import { execSync, spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import type { DownloadResult } from "./downloader";

/** Resolve the ffmpeg binary: explicit FFMPEG_PATH file > local dir binary > PATH. */
export function getFfmpegBinary(): string {
  const envPath = (process.env.FFMPEG_PATH || "").trim();
  if (envPath) {
    try {
      const resolved = path.resolve(envPath);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
    } catch {}
    // If FFMPEG_PATH points to something on PATH or is a dir, fall through.
    if (!envPath.includes("/") && !envPath.includes("\\")) return envPath;
  }
  const localWin = path.join(config.ffmpegDir, "ffmpeg.exe");
  const localNix = path.join(config.ffmpegDir, "ffmpeg");
  try {
    if (fs.existsSync(localWin)) return localWin;
  } catch {}
  try {
    if (fs.existsSync(localNix)) return localNix;
  } catch {}
  return process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
}

/** ffmpeg version string when the binary runs, else null. Cached. */
let _ffmpegVersion: string | null | undefined;
export function getFfmpegVersion(): string | null {
  if (_ffmpegVersion !== undefined) return _ffmpegVersion;
  try {
    const out = execSync(`"${getFfmpegBinary()}" -version`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
      windowsHide: true,
    });
    _ffmpegVersion = out.split("\n")[0].replace(/^ffmpeg version\s+/, "").split(/\s+/)[0] || "unknown";
  } catch {
    _ffmpegVersion = null;
  }
  return _ffmpegVersion;
}

/** True when this ffmpeg build can encode H.264 (preferred) — else mpeg4 fallback. Cached. */
let _hasLibx264: boolean | null = null;
export function hasLibx264(): boolean {
  if (_hasLibx264 !== null) return _hasLibx264;
  try {
    const out = execSync(`"${getFfmpegBinary()}" -hide_banner -encoders`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
      windowsHide: true,
    });
    _hasLibx264 = /(^|\s)libx264(\s|$)/m.test(out);
  } catch {
    _hasLibx264 = false;
  }
  return _hasLibx264;
}

export interface MediaProbe {
  hasVideo: boolean;
  hasAudio: boolean;
  videoCodec: string | null;
  pixFmt: string | null;
  width: number;
  height: number;
  audioCodec: string | null;
  durationSec: number;
}

/**
 * Probe a media file via `ffmpeg -i` (no ffprobe dependency — only the
 * ffmpeg binary is guaranteed on servers). Returns null when ffmpeg itself
 * couldn't run; otherwise a probe with hasVideo=false for invalid files
 * (playlist saved as .mp4, error pages, truncated downloads…).
 */
export function probeMedia(filePath: string): MediaProbe | null {
  const empty: MediaProbe = {
    hasVideo: false, hasAudio: false, videoCodec: null, pixFmt: null,
    width: 0, height: 0, audioCodec: null, durationSec: 0,
  };
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) return { ...empty };
    // Bounded: ffmpeg on a corrupt/HLS-page file can hang parsing headers, and
    // spawnSync blocks the WHOLE event loop (Telegram updates, health checks).
    const r = spawnSync(getFfmpegBinary(), ["-hide_banner", "-i", filePath], {
      encoding: "utf8",
      timeout: 30000,
      windowsHide: true,
    });
    if (r.error) return null;
    const out = String(r.stderr || "") + "\n" + String(r.stdout || "");
    if (/moov atom not found|Invalid data found|Unable to find a suitable/i.test(out)) {
      return { ...empty };
    }
    const probe: MediaProbe = { ...empty };
    const dur = out.match(/Duration:\s*(\d+):(\d+):([\d.]+)/);
    if (dur) {
      probe.durationSec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
    }
    const vLine = (out.match(/Stream #\d+:\d+[^\n]*Video:[^\n]*/) || [])[0] || "";
    if (vLine) {
      probe.hasVideo = true;
      probe.videoCodec = (vLine.match(/Video:\s*([A-Za-z0-9_-]+)/) || [])[1]?.toLowerCase() || null;
      probe.pixFmt = (vLine.match(/,\s*([a-z0-9]+)\s*\(/) || [])[1]?.toLowerCase() || null;
      const wh = vLine.match(/(\d{2,5})x(\d{2,5})/);
      if (wh) {
        probe.width = Number(wh[1]);
        probe.height = Number(wh[2]);
      }
    }
    const aLine = (out.match(/Stream #\d+:\d+[^\n]*Audio:[^\n]*/) || [])[0] || "";
    if (aLine) {
      probe.hasAudio = true;
      probe.audioCodec = (aLine.match(/Audio:\s*([A-Za-z0-9_-]+)/) || [])[1]?.toLowerCase() || null;
    }
    return probe;
  } catch {
    return null;
  }
}

function runFfmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getFfmpegBinary(), args, { shell: false });
    let err = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error("ffmpeg timed out"));
    }, timeoutMs);
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(err.slice(-300).trim() || `ffmpeg exit ${code}`));
    });
  });
}

/**
 * Normalize a Pinterest MP4 for maximum player compatibility.
 *
 * Why a FULL re-encode and not a remux: Pinterest's MP4s (AWS Elemental
 * encodes) carry an `elst` edit list that strict players (Telegram's in-app
 * player, iOS AVPlayer, some Android players) honor as blank/held frames —
 * black picture with working audio — while desktop players ignore the edit
 * list and play fine. A stream-copy remux preserves the edit list, so it
 * cannot fix this; only re-encoding (which rebuilds every timestamp from
 * decoded frames) plus `-use_editlist 0` guarantees a clean file. It also
 * fixes any other source weirdness in one stroke: HEVC/VP9/AV1 video (black
 * on phones that lack the decoder), odd pixel formats, negative CTS offsets,
 * odd dimensions, HE-AAC audio quirks.
 *
 * Output is always baseline-compatible: H.264 + yuv420p + AAC-LC (or mpeg4
 * when the build has no libx264), even dimensions, moov first.
 *
 * Chain (never throws — returns the original result when everything fails):
 *   1. transcode → decode-verify → probe check → accept
 *   2. fast remux fallback (edit-list strip, no re-encode) → same checks
 *   3. original file
 */
export async function normalizePinterestMp4(result: DownloadResult): Promise<DownloadResult> {
  // Free-tier hosts (Render 0.1 CPU) can spend minutes on a single re-encode;
  // PINTEREST_NORMALIZE=false sends the original MP4 untouched instead — but
  // the raw Pinterest MP4 is exactly what shows "black video + working audio"
  // in Telegram's player, so this is a last-resort switch, not a speed knob.
  if (!config.pinterestNormalize) return result;
  if (getFfmpegVersion() === null) {
    console.warn(
      "⚠️ Pinterest normalize SKIPPED: ffmpeg not found — the raw Pinterest MP4 can show black video with audio on strict players (build.sh installs a static ffmpeg; check /diag on the deployed bot)."
    );
    return result;
  }
  const probe = probeMedia(result.filePath);
  const inDesc = probe && probe.hasVideo
    ? `${probe.videoCodec || "?"}${probe.pixFmt ? `/${probe.pixFmt}` : ""}${probe.hasAudio ? `+${probe.audioCodec || "?"}` : ""}`
    : "unprobed";
  const fixedPath = result.filePath.replace(/\.mp4$/i, "") + "_norm.mp4";
  const durationSec = probe && probe.durationSec > 0 ? probe.durationSec : 60;
  // Capped so the encode can never consume the whole per-download budget on its
  // own (download + upload still need room). If it does not finish in time the
  // original file is sent instead of the user getting a timeout.
  const timeoutMs = Math.min(240000, Math.max(90000, Math.ceil(durationSec * 12000)));

  const accept = (label: string): DownloadResult | null => {
    try {
      const stat = fs.statSync(fixedPath);
      if (stat.size === 0) return null;
      const check = probeMedia(fixedPath);
      if (!check || !check.hasVideo) return null;
      if (!decodeVerifies(fixedPath)) return null;
      try { fs.unlinkSync(result.filePath); } catch {}
      console.log(`📌 Pinterest MP4 normalized (${label}, ${inDesc} → h264/yuv420p+aac): ${path.basename(fixedPath)} (${(stat.size / 1048576).toFixed(1)} MB)`);
      return { ...result, filePath: fixedPath, fileName: path.basename(fixedPath), size: stat.size };
    } catch {
      return null;
    }
  };
  const cleanup = (): void => {
    try { if (fs.existsSync(fixedPath)) fs.unlinkSync(fixedPath); } catch {}
  };

  // --- 1) Full transcode (the actual black-screen fix) ----------------------
  // Preset is configurable: on a 0.1-CPU free tier the encode is the slowest
  // step of a Pinterest download, and it happens INSIDE the download timeout.
  const preset = config.pinterestX264Preset;
  const videoArgs = hasLibx264()
    ? ["-c:v", "libx264", "-preset", preset, "-crf", "23", "-pix_fmt", "yuv420p"]
    : ["-c:v", "mpeg4", "-q:v", "4", "-pix_fmt", "yuv420p"];
  try {
    await runFfmpeg(
      [
        "-y", "-v", "error",
        "-ignore_editlist", "1",
        "-i", result.filePath,
        "-map", "0:v:0", "-map", "0:a?",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
        ...videoArgs,
        ...(probe?.hasAudio === false ? ["-an"] : ["-c:a", "aac", "-b:a", "128k"]),
        "-use_editlist", "0",
        "-movflags", "+faststart+negative_cts_offsets",
        fixedPath,
      ],
      timeoutMs
    );
    const done = accept(hasLibx264() ? "re-encoded H.264" : "re-encoded mpeg4");
    if (done) return done;
    console.warn("⚠️ Pinterest transcode output failed verification, trying fast remux…");
  } catch (err: any) {
    console.warn(`⚠️ Pinterest transcode failed (${(err?.message || String(err)).slice(0, 100)}), trying fast remux…`);
  }
  cleanup();

  // --- 2) Fast remux fallback (edit-list strip, no re-encode) ---------------
  try {
    await runFfmpeg(
      [
        "-y", "-v", "error",
        "-ignore_editlist", "1",
        "-fflags", "+genpts",
        "-i", result.filePath,
        "-c", "copy", "-map", "0:v:0", "-map", "0:a?",
        "-use_editlist", "0",
        "-movflags", "+faststart+negative_cts_offsets",
        fixedPath,
      ],
      120000
    );
    const done = accept("edit-list stripped");
    if (done) return done;
  } catch (err: any) {
    console.warn(`⚠️ Pinterest remux failed: ${(err?.message || String(err)).slice(0, 100)}`);
  }
  cleanup();

  // --- 3) Give up gracefully: send the original ------------------------------
  console.warn("⚠️ Pinterest normalize skipped, sending original.");
  return result;
}

/**
 * Full decode test: catches truncated/corrupt files that still probe OK
 * (probe only reads headers). Returns true when every frame decodes cleanly.
 */
function decodeVerifies(filePath: string): boolean {
  try {
    // Full decode of a long video takes a while, but it must stay bounded: a
    // file that makes ffmpeg loop forever would freeze the event loop.
    const r = spawnSync(getFfmpegBinary(), ["-v", "error", "-i", filePath, "-f", "null", "-"], {
      encoding: "utf8",
      timeout: 300000,
      windowsHide: true,
    });
    if (r.error) return false;
    // Any decode error/warning on stderr means a damaged stream.
    return String(r.stderr || "").trim().length === 0;
  } catch {
    return false;
  }
}
