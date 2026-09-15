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
    const out = execSync(`"${getFfmpegBinary()}" -version`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    _ffmpegVersion = out.split("\n")[0].replace(/^ffmpeg version\s+/, "").split(/\s+/)[0] || "unknown";
  } catch {
    _ffmpegVersion = null;
  }
  return _ffmpegVersion;
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
    const r = spawnSync(getFfmpegBinary(), ["-hide_banner", "-i", filePath], { encoding: "utf8" });
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
 * Root cause of the "black screen" reports: Pinterest's MP4s (AWS Elemental
 * encodes) carry an `elst` edit list that strict players (Telegram's in-app
 * player, iOS AVPlayer, some Android players) honor as blank/held frames,
 * while desktop players ignore it — so the file looks fine locally but plays
 * black in Telegram. A stream-copy remux preserves the edit list, which is
 * why copying alone didn't fix it.
 *
 * - Typical case (H.264 + yuv420p, which is nearly all Pinterest output):
 *   fast stream-copy with `-ignore_editlist` (drops the edit list), rebuilt
 *   timestamps and moov-first. No re-encode, takes ~1s.
 * - Exotic case (HEVC/VP9/odd pixel format): full transcode to baseline
 *   H.264 + yuv420p + AAC so every phone can decode it.
 *
 * Never throws — returns the original result on any failure (missing ffmpeg
 * or missing libx264 included).
 */
export async function normalizePinterestMp4(result: DownloadResult): Promise<DownloadResult> {
  if (getFfmpegVersion() === null) return result;
  const probe = probeMedia(result.filePath);
  const needsTranscode = !probe || !probe.hasVideo ||
    probe.videoCodec !== "h264" ||
    !(probe.pixFmt === "yuv420p" || probe.pixFmt === "yuvj420p");
  const fixedPath = result.filePath.replace(/\.mp4$/i, "") + "_norm.mp4";
  const args = needsTranscode
    ? [
        "-y", "-v", "error",
        "-ignore_editlist", "1",
        "-i", result.filePath,
        "-map", "0",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p",
        ...(probe?.hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
        "-movflags", "+faststart",
        fixedPath,
      ]
    : [
        "-y", "-v", "error",
        "-ignore_editlist", "1",
        "-fflags", "+genpts",
        "-i", result.filePath,
        "-c", "copy", "-map", "0",
        // -use_editlist 0 is what actually drops the elst box on copy
        // (input-side -ignore_editlist alone still remuxes it); +faststart
        // puts moov first and +negative_cts_offsets keeps B-frame CTS
        // valid for strict players.
        "-use_editlist", "0",
        "-movflags", "+faststart+negative_cts_offsets",
        fixedPath,
      ];
  try {
    await runFfmpeg(args, 600000);
    const stat = fs.statSync(fixedPath);
    if (stat.size === 0) throw new Error("empty remux output");
    const check = probeMedia(fixedPath);
    if (!check || !check.hasVideo) throw new Error("normalized file has no video track");
    try { fs.unlinkSync(result.filePath); } catch {}
    console.log(`📌 Pinterest MP4 normalized for playback (${needsTranscode ? "re-encoded H.264" : "edit-list stripped"}): ${path.basename(fixedPath)} (${(stat.size / 1048576).toFixed(1)} MB)`);
    return { ...result, filePath: fixedPath, fileName: path.basename(fixedPath), size: stat.size };
  } catch (err: any) {
    try { if (fs.existsSync(fixedPath)) fs.unlinkSync(fixedPath); } catch {}
    console.warn(`⚠️ Pinterest normalize skipped, sending original: ${(err?.message || String(err)).slice(0, 130)}`);
    return result;
  }
}
