import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import type { DownloadProgress, DownloadResult } from "./downloader";

/**
 * YouTube via local yt-dlp — the FINAL fallback method in the pipeline.
 *
 * Why this is "another method" and not more of the same:
 * - Cobalt / Piped / Invidious resolve on THIRD-PARTY server IPs.
 * - youtubei multi-client posts from OUR IP but only reads direct `url`
 *   fields (no signature deciphering, no JS challenges, no cookies).
 * - yt-dlp is a different engine: it solves YouTube's JS challenges
 *   (with node), deciphers signatureCipher'd streams, rotates its own
 *   player clients (android/ios/mweb/tv/web), can attach login cookies,
 *   can impersonate Chrome TLS, and can route via a residential proxy.
 *   Videos that are unwinnable for plain-HTTPS pipelines regularly still
 *   download here — and vice versa. That independence is the point.
 *
 * Order inside this method: anonymous client stacks first
 * (mobile [android,ios,mweb] → embed [web_safari,tv] → yt-dlp defaults →
 * mobile again over IPv6 when available), then cookie-attached attempts
 * (when cookies exist and YOUTUBE_COOKIE_MODE allows them), so most
 * public videos download without ever touching the login session. The embed
 * stack talks to YouTube's embed/safari player API, which is far less
 * guarded than the watch-page player; the IPv6 stack is a genuinely
 * different egress IP that is often clean while the IPv4 is flagged.
 * (web_embedded/tv_embedded are deliberately NOT listed: web_embedded
 * answers error 152 for ordinary videos and tv_embedded isn't a valid
 * player_client in current yt-dlp — both just burn rotation time.)
 * Disable with YOUTUBE_YTDLP_FALLBACK=false.
 *
 * Returns the downloaded file on success, null when every attempt fails
 * (caller builds the final user-facing error), and throws user-facing
 * errors (❌…) for definitive failures (private/deleted/too large).
 */

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

let _hasNode: boolean | null = null;
function hasNodeRuntime(): boolean {
  if (_hasNode === null) {
    try {
      execSync("node --version", { stdio: "ignore" });
      _hasNode = true;
    } catch {
      _hasNode = false;
    }
  }
  return _hasNode;
}

let _impersonate: boolean | null = null;
function supportsImpersonate(): boolean {
  if (_impersonate === null) {
    const bin = resolveYtDlpPath();
    if (!bin) {
      _impersonate = false;
    } else {
      try {
        execSync(`"${bin}" --impersonate chrome --version`, { stdio: "ignore" });
        _impersonate = true;
      } catch {
        _impersonate = false;
      }
    }
  }
  return _impersonate;
}

let _aria2c: boolean | null = null;
function hasAria2c(): boolean {
  if (_aria2c === null) {
    try {
      execSync("aria2c --version", { stdio: "ignore" });
      _aria2c = true;
    } catch {
      _aria2c = false;
    }
  }
  return _aria2c;
}

/**
 * Resolve the yt-dlp binary: explicit YT_DLP_PATH first, then a copy shipped
 * next to the bot (./yt-dlp.exe on Windows, ./yt-dlp elsewhere — the repo
 * root on a local PC, or the ffmpeg dir), then PATH lookup. Cached.
 * Returns "" when nothing works (caller skips with a clear warning).
 */
let _resolvedYtDlp: string | null = null;
function resolveYtDlpPath(): string {
  if (_resolvedYtDlp !== null) return _resolvedYtDlp;
  const exe = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const candidates: string[] = [
    config.ytDlpPath,
    path.join(process.cwd(), exe),
    path.join(config.ffmpegDir, exe),
  ];
  for (const c of candidates) {
    try {
      execSync(`"${c}" --version`, { stdio: "ignore" });
      _resolvedYtDlp = c;
      if (c !== config.ytDlpPath) console.log(`🔧 YouTube yt-dlp fallback: YT_DLP_PATH unusable, using binary at ${c}`);
      return _resolvedYtDlp;
    } catch {}
  }
  _resolvedYtDlp = "";
  return _resolvedYtDlp;
}

function ytDlpAvailable(): boolean {
  return resolveYtDlpPath().length > 0;
}

/** Why the fallback would/wouldn't run — surfaced in the final error for the admin. */
export function ytDlpFallbackStatus(): "ready" | "disabled" | "missing" {
  if (!config.youtubeYtdlpFallback) return "disabled";
  return ytDlpAvailable() ? "ready" : "missing";
}

/** Any cookie source configured (browser / env / usable file)? */
export function hasUsableCookies(): boolean {
  if (config.cookiesFromBrowser) return true;
  if (config.cookiesContent) return true;
  try {
    const st = fs.statSync(config.cookiesPath);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

/**
 * Best-effort YouTube visitor data (fixes "PO Token … Missing required
 * Visitor Data" for web clients). Fetched from our own IP from the YouTube
 * homepage; cached 1h. Null when unreachable — callers simply omit it.
 */
let _visitorData: { at: number; value: string | null } | null = null;
async function fetchVisitorData(): Promise<string | null> {
  const now = Date.now();
  if (_visitorData && now - _visitorData.at < 3600 * 1000) return _visitorData.value;
  let value: string | null = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch("https://www.youtube.com/", {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal: controller.signal,
      });
      if (res.ok) {
        const html = await res.text();
        value = html.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1] || null;
      }
    } finally {
      clearTimeout(timeout);
    }
  } catch {}
  _visitorData = { at: now, value };
  return value;
}

/** Format selector: mobile stacks get itag-18 progressive (no merge); rest is height-capped. */
function formatFor(mobile: boolean): string {
  if (mobile) {
    return "18/b[ext=mp4]/b";
  }
  const h = config.youtubeMaxHeight;
  if (h > 0) {
    return `bv*[ext=mp4][height<=${h}]+ba[ext=m4a]/b[ext=mp4][height<=${h}]/b[height<=${h}]/b`;
  }
  return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b";
}

interface AttemptSpec {
  name: string;
  /** Ordered client list (yt-dlp falls through internally); null = yt-dlp defaults. */
  playerClients: string[] | null;
  useCookies: boolean;
  /** false = omit --force-ipv4 so the OS may route via IPv6 (a different, often clean, egress). */
  ipv4: boolean;
  mobile: boolean;
}

/**
 * Per-stack rotation. Each attempt hands yt-dlp an ORDERED client list so
 * one process covers several per-(video, IP, client) lottery draws (with a
 * shared JS-challenge cache) instead of spawning a process per client.
 * Anonymous first (auto), cookies first (cookies), anon only (never).
 */
function attemptsForYouTube(): AttemptSpec[] {
  const v4 = config.ytDlpForceIpv4;
  const anon: AttemptSpec[] = [
    { name: "mobile", playerClients: ["android", "ios", "mweb"], useCookies: false, ipv4: v4, mobile: true },
    // web_safari/tv talk to the embed/safari player, which YouTube guards
    // far less than the watch page — they often win on IPs where every
    // default client is "Sign in to confirm you're not a bot"-walled.
    { name: "embed", playerClients: ["web_safari", "tv"], useCookies: false, ipv4: v4, mobile: false },
    { name: "default", playerClients: null, useCookies: false, ipv4: v4, mobile: false },
  ];
  // Same mobile stack without --force-ipv4: when the host has IPv6, this is
  // a genuinely different egress IP that is often NOT flagged while the
  // IPv4 is. Fails fast where there is no IPv6 route.
  if (v4) {
    anon.push({ name: "mobile-v6", playerClients: ["android", "ios", "mweb"], useCookies: false, ipv4: false, mobile: true });
  }
  const mode = config.youtubeCookieMode;
  if (mode === "never" || !hasUsableCookies()) return anon;
  const withCookies: AttemptSpec[] = [
    { name: "mobile+cookies", playerClients: ["android", "ios", "mweb"], useCookies: true, ipv4: v4, mobile: true },
    { name: "default+cookies", playerClients: null, useCookies: true, ipv4: v4, mobile: false },
  ];
  return mode === "cookies" ? [...withCookies, ...anon] : [...anon, ...withCookies];
}

/** Extra yt-dlp args for one YouTube attempt. */
function buildYoutubeArgs(
  playerClients: string[] | null,
  format: string,
  useCookies: boolean,
  ipv4: boolean,
  visitorData: string | null
): string[] {
  const args: string[] = [];
  if (useCookies) {
    if (config.cookiesFromBrowser) {
      args.push("--cookies-from-browser", config.cookiesFromBrowser);
    } else {
      try {
        if (fs.existsSync(config.cookiesPath)) args.push("--cookies", config.cookiesPath);
      } catch {}
    }
  }
  // Combine youtube extractor keys into ONE --extractor-args (semicolon-separated).
  const ytKeys: string[] = [];
  if (playerClients) ytKeys.push(`player_client=${playerClients.join(",")}`);
  if (config.youtubePlayerSkip) ytKeys.push("player_skip=webpage,configs");
  if (visitorData) ytKeys.push(`visitor_data=${visitorData}`);
  if (ytKeys.length > 0) args.push("--extractor-args", `youtube:${ytKeys.join(";")}`);
  if (config.ytDlpProxy) args.push("--proxy", config.ytDlpProxy);
  if (ipv4) args.push("--force-ipv4");
  if (config.potServerUrl) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${config.potServerUrl}`);
  }
  if (hasNodeRuntime()) args.push("--js-runtimes", "node");
  if (supportsImpersonate()) args.push("--impersonate", "chrome");
  args.push(
    "--concurrent-fragments", "8",
    "--http-chunk-size", "10M",
    "--buffer-size", "16K",
    "--socket-timeout", "10",
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-check-certificates"
  );
  if (hasAria2c()) {
    args.push(
      "--downloader", "aria2c",
      "--downloader-args", "aria2c:-x 8 -s 8 -k 1M --min-split-size=1M"
    );
  }
  if (config.ytDlpExtraArgs.length > 0) args.push(...config.ytDlpExtraArgs);
  args.push("-f", format);
  return args;
}

function isFatalError(msg: string): boolean {
  // NOTE: "Requested format is not available" is DELIBERATELY not fatal
  // here (unlike the single-attempt platforms): it only means THIS client
  // has no matching format for the video (SABR-only response, n-challenge
  // without a JS runtime, embed-restricted rendition…) — the next client in
  // the rotation usually does. Aborting on it turned one client's format gap
  // into a bogus "Video unavailable or private" for the whole video.
  return (
    msg.includes("Unsupported URL") ||
    msg.includes("Video unavailable") ||
    msg.includes("Private video") ||
    msg.includes("This video is private") ||
    msg.includes("max-filesize") ||
    msg.includes("File is larger than")
  );
}

function isBotCheck(msg: string): boolean {
  return (
    /Sign in to confirm you.{0,10}re not a bot/i.test(msg) ||
    /not a bot/i.test(msg) ||
    /LOGIN_REQUIRED/.test(msg) ||
    /The page needs to be reloaded/i.test(msg) ||
    /confirm your age/i.test(msg) ||
    /use --cookies/i.test(msg) ||
    /Failed to extract any player response/i.test(msg)
  );
}

function runYtDlpAttempt(args: string[], onProgress?: (p: DownloadProgress) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveYtDlpPath(), args, { shell: false });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });
    proc.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });
    proc.on("error", (err) => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
      resolve(stdout);
    });
  });
}

function resolveDownloadedFile(stdout: string, id: string): DownloadResult {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  let filePath = lines.find((l) => l.endsWith(".mp4"));
  if (!filePath) filePath = lines[lines.length - 1];
  if (!filePath || !fs.existsSync(filePath)) {
    const files = fs.readdirSync(config.downloadDir)
      .filter((f) => f.startsWith(id + "_") && f.endsWith(".mp4"))
      .map((f) => path.join(config.downloadDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) filePath = files[0];
  }
  if (!filePath || !fs.existsSync(filePath)) {
    const files = fs.readdirSync(config.downloadDir)
      .filter((f) => f.startsWith(id + "_"))
      .map((f) => path.join(config.downloadDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) filePath = files[0];
  }
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error("Download completed but file not found. Check yt-dlp output.");
  }
  const ext = path.extname(filePath).slice(1).toLowerCase() || "mp4";
  if (AUDIO_EXTENSIONS.has(ext)) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(
      `❌ yt-dlp returned an audio file (.${ext}) instead of video. ` +
      `This URL may not have a downloadable video. Try a different link.`
    );
  }
  const stat = fs.statSync(filePath);
  return { filePath, fileName: path.basename(filePath), ext, size: stat.size, platform: "youtube" };
}

export interface YtDlpSummary {
  tried: number;
  walled: number;
}

let _lastSummary: YtDlpSummary = { tried: 0, walled: 0 };
export function getLastYtDlpSummary(): YtDlpSummary {
  return { ..._lastSummary };
}

export async function downloadYouTubeViaYtDlp(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult | null> {
  if (!config.youtubeYtdlpFallback) return null;
  if (!ytDlpAvailable()) {
    console.warn(
      `⚠️ YouTube yt-dlp fallback skipped: no working binary (tried YT_DLP_PATH="${config.ytDlpPath}" + local copy). ` +
        `Set YT_DLP_PATH to the yt-dlp binary (Render installs it via build.sh; locally place yt-dlp.exe next to the bot).`
    );
    return null;
  }
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });

  const id = crypto.randomBytes(6).toString("hex");
  const template = path.join(config.downloadDir, `${id}_%(title).100s.%(ext)s`);
  const baseArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format", "mp4",
    "--ffmpeg-location", config.ffmpegDir,
    "--downloader-args", "ffmpeg:-threads 0",
    "--max-filesize", `${config.maxFileSizeMB}M`,
    "-o", template,
    "--no-mtime",
  ];

  const attempts = attemptsForYouTube();
  const summary: YtDlpSummary = { tried: 0, walled: 0 };
  // Visitor data (for web clients' PO-token checks) is fetched once per
  // rotation, best-effort — null on walled/offline networks, which is fine.
  const visitorData = await fetchVisitorData();
  let lastError = "";
  for (const attempt of attempts) {
    summary.tried++;
    const args = [
      ...baseArgs,
      ...buildYoutubeArgs(attempt.playerClients, formatFor(attempt.mobile), attempt.useCookies, attempt.ipv4, visitorData),
      "--print", "after_move:filepath",
      url,
    ];
    try {
      console.log(`⏳ YouTube yt-dlp attempt: ${attempt.name}${attempt.useCookies ? " (cookies)" : " (anonymous)"}${attempt.ipv4 ? "" : " (IPv6 route)"}…`);
      const stdout = await runYtDlpAttempt(args, onProgress);
      const result = resolveDownloadedFile(stdout, id);
      _lastSummary = summary;
      console.log(`✅ YouTube yt-dlp saved via ${attempt.name}: ${result.fileName} (${(result.size / 1048576).toFixed(1)} MB)`);
      return result;
    } catch (err: any) {
      lastError = err?.message || String(err);
      if (lastError.startsWith("❌")) throw err; // definitive (too large / audio-only)
      if (isBotCheck(lastError)) summary.walled++;
      console.warn(`⚠️ YouTube yt-dlp "${attempt.name}" failed: ${lastError.slice(0, 180)}`);
      if (isFatalError(lastError)) {
        _lastSummary = summary;
        if (lastError.includes("max-filesize") || lastError.includes("File is larger than")) {
          throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
        }
        if (lastError.includes("Unsupported URL")) {
          throw new Error("❌ Unsupported URL. Make sure the link is a public video.");
        }
        if (/Private video|This video is private|Video unavailable/.test(lastError)) {
          throw new Error("❌ Video unavailable or private.");
        }
        throw new Error("❌ Video unavailable or private.");
      }
    }
  }
  _lastSummary = summary;
  console.warn(`⚠️ All YouTube yt-dlp attempts failed (${summary.tried} tried, ${summary.walled} bot-walled). Last: ${lastError.slice(0, 150)}`);
  return null;
}
