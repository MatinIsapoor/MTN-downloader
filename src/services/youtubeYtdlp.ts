import { spawn, execFileSync } from "child_process";
import type { ChildProcess } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import { lowerHeights, isTooLargeMessage } from "./quality";
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

// All capability probes below must be bounded and shell-free. They run
// synchronously on the bot's event loop (the attempt builders are sync), so a
// hung binary would freeze EVERYTHING — Telegram updates, health checks, other
// downloads. execFileSync with a hard timeout forces a kill; passing the
// binary/args as separate argv entries (instead of execSync's interpolated
// shell string) also removes shell parsing from values like YT_DLP_PATH.
const PROBE_TIMEOUT_MS = 10000;

let _hasNode: boolean | null = null;
function hasNodeRuntime(): boolean {
  if (_hasNode === null) {
    try {
      execFileSync("node", ["--version"], { stdio: "ignore", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
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
        execFileSync(bin, ["--impersonate", "chrome", "--version"], {
          stdio: "ignore",
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
        });
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
      execFileSync("aria2c", ["--version"], { stdio: "ignore", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
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
      execFileSync(c, ["--version"], { stdio: "ignore", timeout: PROBE_TIMEOUT_MS, windowsHide: true });
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
    if (!st.isFile() || st.size === 0) return false;
    // "Non-empty" is not the same as "usable": the file only helps if it holds
    // youtube.com cookies. An export from another site (or a truncated file)
    // otherwise made the rotation spend its cookie-attempts on a source that
    // cannot work, and suppressed the "no cookies installed" hint in the final
    // error. Netscape cookie files are small; the read is capped so a huge or
    // wrong file can never stall the event loop.
    if (st.size > 4 * 1024 * 1024) return false;
    return fs.readFileSync(config.cookiesPath, "utf8").includes("youtube.com");
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
        const candidate = html.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1] || null;
        // This value is spliced into one yt-dlp `--extractor-args` string, where
        // ";" separates options and "," separates values. HTML is site-supplied
        // data, so only keep characters a real visitorData value can contain;
        // otherwise a weird/malicious page could inject extra extractor
        // options into every attempt of this rotation.
        value = candidate && /^[A-Za-z0-9_+/%=.-]{1,4096}$/.test(candidate) ? candidate : null;
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
  return formatForHeight(mobile, config.youtubeMaxHeight);
}

/** Same selector pinned to an explicit height (for lower-quality retries). */
function formatForHeight(mobile: boolean, height: number): string {
  if (mobile) {
    // Progressive itag ladder: 18 (360p) → 59/59… yt-dlp understands
    // "18/worst" chains; keep 18 first (most reliable) with generic fallback.
    if (height > 0 && height < 360) return "36/17/18/b[ext=mp4]/b";
    return "18/b[ext=mp4]/b";
  }
  if (height > 0) {
    return `bv*[ext=mp4][height<=${height}]+ba[ext=m4a]/b[ext=mp4][height<=${height}]/b[height<=${height}]/b`;
  }
  return "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b";
}

/** True when yt-dlp's output means "over --max-filesize" (retry lower). */
function isTooLargeOutput(msg: string): boolean {
  return isTooLargeMessage(msg);
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

/**
 * Kill a child process AND every descendant. yt-dlp spawns helper processes of
 * its own (ffmpeg for the DASH merge, aria2c for the parallel down-loader), so
 * killing only the direct child on timeout leaves those grandchildren running:
 * they keep the output files open and keep burning bandwidth/CPU, and they can
 * corrupt the NEXT attempt of this same download (same output template).
 * POSIX: the attempt is spawned detached, i.e. it leads its own process group —
 * a negative PID kills the whole group. Windows has no signal-to-group, so
 * `taskkill /T` walks the child tree instead. Always best-effort: the process
 * may already be gone.
 */
function killProcessTree(proc: ChildProcess): void {
  const pid = proc.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      // windowsHide: never flash a console window on the bot's host.
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.on("error", () => {});
      return;
    }
    process.kill(-pid, "SIGKILL");
  } catch {
    try { proc.kill("SIGKILL"); } catch {}
  }
}

/**
 * Run one yt-dlp attempt with a hard timeout (free-tier safety: a stuck
 * client would otherwise hang the bot forever) and bounded output buffers
 * (memory safety: progress lines accumulate on long downloads).
 */
function runYtDlpAttempt(
  args: string[],
  onProgress?: (p: DownloadProgress) => void,
  timeoutMs: number = config.ytDlpAttemptTimeoutMs
): Promise<string> {
  const MAX_BUF = 512 * 1024; // 512KB cap per stream
  return new Promise((resolve, reject) => {
    const proc = spawn(resolveYtDlpPath(), args, {
      shell: false,
      windowsHide: true,
      // POSIX: own process group so a timeout can kill yt-dlp + ffmpeg/aria2c.
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killProcessTree(proc);
      reject(new Error(`yt-dlp attempt timed out after ${Math.round(timeoutMs / 1000)}s (network stall or blocked client)`));
    }, timeoutMs);
    const append = (target: string, s: string): string => {
      // Keep the TAIL, not the head: the actionable lines (the final error, the
      // "after_move" filepath) are the LAST thing yt-dlp writes. The old
      // early-return stopped appending once the cap was hit, so those final
      // lines were dropped exactly when output was long (a long download's
      // progress spam) and the real failure cause was lost.
      const next = target + s;
      return next.length > MAX_BUF ? next.slice(-MAX_BUF) : next;
    };
    proc.stdout.on("data", (d: Buffer) => {
      // After a timeout we already rejected and killed the tree: ignore late
      // output so a dying attempt can't keep emitting stale progress into the
      // NEXT attempt's user-facing message.
      if (settled) return;
      const s = d.toString();
      stdout = append(stdout, s);
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });
    proc.stderr.on("data", (d: Buffer) => {
      if (settled) return;
      const s = d.toString();
      stderr = append(stderr, s);
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn yt-dlp: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
      resolve(stdout);
    });
  });
}

function resolveDownloadedFile(stdout: string, id: string): DownloadResult {
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);
  let filePath = lines.find((l) => l.endsWith(".mp4"));
  if (!filePath) filePath = lines[lines.length - 1];
  // Never trust a path printed by an external tool: only accept a file this
  // download wrote inside DOWNLOAD_DIR. Otherwise a crafted output line (or a
  // future yt-dlp change) could make the bot read/upload an arbitrary local
  // file. The fallback scans below are dir-scoped and don't need the check.
  const downloadRoot = path.resolve(config.downloadDir) + path.sep;
  if (filePath && !path.resolve(filePath).startsWith(downloadRoot)) filePath = undefined;
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
  // --max-filesize is enforced by yt-dlp PER STREAM, so a DASH merge can still
  // produce a file over the cap (video + audio each under the limit, sum over).
  // Re-check the finished file: this throws the too-large marker so the caller's
  // quality ladder retries lower instead of handing Telegram an over-limit file.
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  if (stat.size > maxBytes) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
  }
  return { filePath, fileName: path.basename(filePath), ext, size: stat.size, platform: "youtube" };
}

/**
 * Remove every file this download left behind in DOWNLOAD_DIR — partial
 * `.part` fragments and split audio streams from timed-out/failed attempts —
 * while keeping the file that is actually being returned. The prefix is a
 * per-download random id, so concurrent downloads (each with its own id) are
 * never touched. Without this, a failed video leaves a full-size partial file
 * until the hourly cleanup (and the disk-budget guard may then delete OTHER
 * users' finished downloads to make room).
 */
function cleanupDownloadFiles(id: string, keepPath?: string): void {
  try {
    const keep = keepPath ? path.resolve(keepPath) : null;
    for (const f of fs.readdirSync(config.downloadDir)) {
      if (!f.startsWith(id + "_")) continue;
      const fp = path.join(config.downloadDir, f);
      if (keep && path.resolve(fp) === keep) continue;
      try { fs.unlinkSync(fp); } catch {}
    }
  } catch {}
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
  // Publish the fresh counters IMMEDIATELY: youtube.ts reads the module-level
  // summary after a throw too, and a stale value from the PREVIOUS download
  // would mis-classify this failure (e.g. claim it was bot-walled).
  _lastSummary = summary;
  // Visitor data (for web clients' PO-token checks) is fetched once per
  // rotation, best-effort — null on walled/offline networks, which is fine.
  const visitorData = await fetchVisitorData();
  let lastError = "";
  let saved: DownloadResult | null = null;
  try {
    for (const attempt of attempts) {
      summary.tried++;
      // Quality ladder for this stack: start at the configured cap, step down
      // when yt-dlp reports over --max-filesize (Telegram limit) instead of
      // failing the video. Bounded to 2 extra heights so one stack can't
      // triple the rotation time.
      // EXCEPT mobile stacks: their progressive itag-18 selector ignores the
      // requested height (see formatForHeight), so a "lower height" retry
      // would re-run the exact same command — two guaranteed-identical
      // timeouts. Mobile stacks get one shot.
      const baseHeight = config.youtubeMaxHeight > 0 ? config.youtubeMaxHeight : 720;
      const heights = attempt.mobile ? [baseHeight] : [baseHeight, ...lowerHeights(baseHeight)].slice(0, 3);
      let stackDone = false;
      for (const h of heights) {
        const args = [
          ...baseArgs,
          ...buildYoutubeArgs(attempt.playerClients, formatForHeight(attempt.mobile, attempt.mobile ? 0 : h), attempt.useCookies, attempt.ipv4, visitorData),
          "--print", "after_move:filepath",
          url,
        ];
        try {
          console.log(`⏳ YouTube yt-dlp attempt: ${attempt.name}${attempt.useCookies ? " (cookies)" : " (anonymous)"}${attempt.ipv4 ? "" : " (IPv6 route)"}${h !== baseHeight ? ` (retry ≤${h}p)` : ""}…`);
          const stdout = await runYtDlpAttempt(args, onProgress);
          const result = resolveDownloadedFile(stdout, id);
          saved = result;
          console.log(`✅ YouTube yt-dlp saved via ${attempt.name}: ${result.fileName} (${(result.size / 1048576).toFixed(1)} MB)`);
          return result;
        } catch (err: any) {
          lastError = err?.message || String(err);
          // Size failures come FIRST: resolveDownloadedFile's post-merge check
          // throws an ❌-prefixed "Video too large" error, and the generic
          // "❌ = definitive" shortcut below would abort the ladder instead of
          // retrying a lower height.
          if (isTooLargeOutput(lastError)) {
            if (h !== heights[heights.length - 1]) {
              console.log(`⚡ YouTube yt-dlp "${attempt.name}" over limit at ≤${h}p, trying lower quality…`);
              continue; // next lower height, same stack
            }
            throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
          }
          if (lastError.startsWith("❌")) throw err; // definitive (audio-only)
          if (isBotCheck(lastError)) summary.walled++;
          console.warn(`⚠️ YouTube yt-dlp "${attempt.name}" failed: ${lastError.slice(0, 180)}`);
          if (isFatalError(lastError)) {
            if (lastError.includes("Unsupported URL")) {
              throw new Error("❌ Unsupported URL. Make sure the link is a public video.");
            }
            throw new Error("❌ Video unavailable or private.");
          }
          stackDone = true;
          break; // non-size failure → next stack (not next height)
        }
      }
      if (stackDone) continue;
    }
    console.warn(`⚠️ All YouTube yt-dlp attempts failed (${summary.tried} tried, ${summary.walled} bot-walled). Last: ${lastError.slice(0, 150)}`);
    return null;
  } finally {
    _lastSummary = summary;
    // Temp-file hygiene: timed-out/killed attempts leave `.part` fragments and
    // split audio streams behind, and the id prefix is unique to this download,
    // so concurrent downloads are unaffected. Keep only the returned file.
    cleanupDownloadFiles(id, saved?.filePath);
  }
}
