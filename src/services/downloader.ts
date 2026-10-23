import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { config } from "../config";
import { detectPlatform } from "../utils/platform";
import { downloadViaCobalt, isCobaltConfigured } from "./cobalt";
import { downloadYouTubeCookieFree } from "./youtube";
import { downloadPinterest } from "./pinterest";
import { isTooLargeMessage } from "./quality";
import { getFfmpegBinary, getFfmpegVersion, hasLibx264, normalizePinterestMp4 } from "./media";

export interface DownloadResult {
  filePath: string;
  fileName: string;
  title?: string;
  ext: string;
  size: number;
  platform: string;
  /**
   * Set for Pinterest image results that are verified image pins (API says
   * the pin has no video). The caller can return these immediately without
   * running the video pipeline.
   */
  confidentImage?: boolean;
}

export interface AudioResult {
  filePath: string;
  fileName: string;
  size: number;
}

export interface DownloadProgress {
  percent?: number;
  speed?: string;
  eta?: string;
}

function ensureDownloadDir(): void {
  if (!fs.existsSync(config.downloadDir)) fs.mkdirSync(config.downloadDir, { recursive: true });
}

// --- Global concurrency guard (free-tier memory safety) -------------------
// Each download spawns yt-dlp/ffmpeg children; unbounded parallelism OOMs a
// 512MB Render instance. Personal use rarely exceeds 1-2 concurrent, so the
// cap only bites during bursts — callers reply "busy, retry shortly".
let activeDownloads = 0;

/** Try to take a download slot. Returns false when the bot is saturated. */
export function tryAcquireDownloadSlot(): boolean {
  if (activeDownloads >= config.maxConcurrentDownloads) return false;
  activeDownloads++;
  return true;
}

export function releaseDownloadSlot(): void {
  activeDownloads = Math.max(0, activeDownloads - 1);
}

export function getActiveDownloadCount(): number {
  return activeDownloads;
}

function checkYtDlp(): boolean {
  try {
    execSync(`"${config.ytDlpPath}" --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function getYtDlpVersion(): string | null {
  try {
    return execSync(`"${config.ytDlpPath}" --version`, { encoding: "utf8" }).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

/** Age of the yt-dlp build in days (parsed from YYYY.MM.DD version), null when unknown. */
export function ytDlpAgeDays(): number | null {
  const v = getYtDlpVersion();
  if (!v) return null;
  const m = v.trim().match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!m) return null;
  try {
    const built = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Math.floor((Date.now() - built) / 86400000);
  } catch {
    return null;
  }
}

/**
 * Best-effort yt-dlp self-update on boot. Only runs when
 * YTDLP_AUTO_UPDATE=true. Never throws — a failed update just logs.
 *
 * Two install flavors exist: binary builds (yt-dlp.exe / linux zip) update
 * via `yt-dlp -U`, but pip installs (what build.sh uses on Render) REFUSE
 * self-update ("installed with pip… use pip to update") — without the pip
 * path below, the server binary would rot in place and YouTube/Pinterest
 * would break on their own within weeks as extractors go stale.
 */
export async function maybeAutoUpdateYtDlp(): Promise<void> {
  if (!config.ytdlpAutoUpdate) return;
  try {
    console.log("🔄 YTDLP_AUTO_UPDATE=true — attempting yt-dlp self-update…");
    const out = await runUpdateCommand(config.ytDlpPath, ["-U"], 120000);
    console.log(`🔄 yt-dlp -U: ${out.slice(-300).trim() || "no output"}`);
    if (/pip install|installed with pip|use pip/i.test(out)) {
      console.log("🔄 yt-dlp is a pip install — upgrading via pip (nightly channel, like build.sh)…");
      const pipOut = await tryPipUpgrade();
      console.log(`🔄 pip upgrade: ${pipOut.slice(-300).trim() || "no output"}`);
    }
  } catch (err: any) {
    console.warn(`⚠️ yt-dlp self-update failed: ${(err?.message || String(err)).slice(0, 120)}`);
  }
}

/** Run an updater command, resolving with combined output even on non-zero exit. */
function runUpdateCommand(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    import("child_process").then(({ spawn: spawnProc }) => {
      const proc = spawnProc(bin, args, { shell: false });
      let out = "";
      proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
      const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve(out || "timed out"); }, timeoutMs);
      proc.on("close", () => {
        clearTimeout(timer);
        resolve(out);
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve(`spawn failed: ${err.message}`);
      });
    }).catch((err) => resolve(`spawn failed: ${(err as Error)?.message || String(err)}`));
  });
}

/** Upgrade a pip-installed yt-dlp (tries python3/pip/python launchers in order). */
async function tryPipUpgrade(): Promise<string> {
  const attempts: Array<{ bin: string; args: string[] }> = [
    { bin: "python3", args: ["-m", "pip", "install", "-U", "--pre", "yt-dlp[default]"] },
    { bin: "pip", args: ["install", "-U", "--pre", "yt-dlp[default]"] },
    { bin: "python", args: ["-m", "pip", "install", "-U", "--pre", "yt-dlp[default]"] },
  ];
  let last = "no pip launcher found";
  for (const a of attempts) {
    const out = await runUpdateCommand(a.bin, a.args, 180000);
    if (/Successfully installed|Requirement already satisfied/i.test(out)) return out;
    last = out;
  }
  return last;
}

// --- Capability probes (cached) -------------------------------------------

let _hasNodeRuntime: boolean | null = null;
/** yt-dlp can solve YouTube JS challenges / PO-token checks when a JS runtime is available. */
function hasNodeRuntime(): boolean {
  if (_hasNodeRuntime === null) {
    try {
      execSync("node --version", { stdio: "ignore" });
      _hasNodeRuntime = true;
    } catch {
      _hasNodeRuntime = false;
    }
  }
  return _hasNodeRuntime;
}

let _supportsImpersonate: boolean | null = null;
/** --impersonate needs a yt-dlp build with curl_cffi; harmless to probe once and cache. */
function supportsImpersonate(): boolean {
  if (_supportsImpersonate === null) {
    try {
      execSync(`"${config.ytDlpPath}" --impersonate chrome --version`, { stdio: "ignore" });
      _supportsImpersonate = true;
    } catch {
      _supportsImpersonate = false;
    }
  }
  return _supportsImpersonate;
}

function hasCookies(): boolean {
  if (config.cookiesFromBrowser) return true;
  if (config.cookiesContent) return true;
  try {
    return fs.existsSync(config.cookiesPath);
  } catch {
    return false;
  }
}

export interface CookieStatus {
  source: "browser" | "env" | "file" | "none";
  path: string;
  total: number;
  youtube: number;
  expiredYoutube: number;
  expiringSoon: number;
  hasLoginSession: boolean;
  valid: boolean;
  detail: string;
  /** Days until the soonest-expiring SESSION cookie expires (null = unknown/none). Negative = already expired. */
  sessionDaysLeft: number | null;
  /** One-line human summary of session freshness for the admin panel. */
  expiryText: string;
}

/** Parse a Netscape cookies file into rows. Returns null when unreadable. */
function parseCookieFile(raw: string): Array<{ domain: string; expires: number; name: string }> | null {
  try {
    const rows: Array<{ domain: string; expires: number; name: string }> = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const parts = t.split("\t");
      if (parts.length < 7) continue;
      const domain = parts[0] || "";
      const expires = Number(parts[4] || "0") || 0;
      const name = parts[5] || "";
      rows.push({ domain, expires, name });
    }
    return rows;
  } catch {
    return null;
  }
}

/** Decode COOKIES_CONTENT (raw Netscape text or base64) into file text. */
export function decodeCookiesEnv(raw: string): string | null {
  const s = (raw || "").trim();
  if (!s) return null;
  if (s.includes("youtube.com") && s.includes("\n")) return s;
  // Try base64 (Render dashboard-safe). Must decode to something cookie-like.
  try {
    const decoded = Buffer.from(s.replace(/\s+/g, ""), "base64").toString("utf8");
    if (decoded.includes("youtube.com") || decoded.includes("# Netscape")) return decoded;
  } catch {}
  // Single-line edge case: env var with literal \n escapes.
  if (s.includes("\\n")) {
    const unescaped = s.replace(/\\n/g, "\n");
    if (unescaped.includes("youtube.com")) return unescaped;
  }
  return null;
}

/** Validate raw cookies text. Shared by file, env var, and Telegram uploads. */
export function validateCookiesContent(raw: string): CookieStatus {
  const empty: CookieStatus = {
    source: "file", path: config.cookiesPath, total: 0, youtube: 0,
    expiredYoutube: 0, expiringSoon: 0, hasLoginSession: false, valid: false,
    detail: "unreadable", sessionDaysLeft: null, expiryText: "unknown",
  };
  const rows = parseCookieFile(raw);
  if (!rows) return empty;
  const now = Math.floor(Date.now() / 1000);
  const soon = now + 7 * 24 * 3600;
  const yt = rows.filter((r) => r.domain.includes("youtube.com"));
  const expired = yt.filter((r) => r.expires !== 0 && r.expires < now).length;
  const expiring = yt.filter((r) => r.expires !== 0 && r.expires >= now && r.expires < soon).length;
  const names = new Set(yt.map((r) => r.name));
  const hasLoginSession =
    (names.has("SID") || names.has("__Secure-1PSID") || names.has("__Secure-3PSID")) &&
    (names.has("LOGIN_INFO") || names.has("SSID") || names.has("HSID"));
  // Session freshness: the login session dies with the earliest-expiring
  // SESSION cookie (SID/HSID/SSID/LOGIN_INFO family), not with prefs cookies
  // (PREF/VISITOR_INFO) that live for years. Report that specifically.
  const SESSION_NAMES = new Set([
    "SID", "__Secure-1PSID", "__Secure-3PSID", "__Secure-1PSIDTS",
    "HSID", "SSID", "__Secure-1PAPISID", "__Secure-3PAPISID",
    "LOGIN_INFO", "SIDCC", "__Secure-3PSIDCC",
  ]);
  const sessionExpiries = yt
    .filter((r) => SESSION_NAMES.has(r.name) && r.expires !== 0)
    .map((r) => r.expires);
  let sessionDaysLeft: number | null = null;
  let expiryText = "unknown";
  if (sessionExpiries.length > 0) {
    const soonest = Math.min(...sessionExpiries);
    sessionDaysLeft = Math.floor((soonest - now) / 86400);
    if (sessionDaysLeft < 0) {
      expiryText = `login session EXPIRED ${-sessionDaysLeft}d ago — refresh now`;
    } else if (sessionDaysLeft <= 7) {
      expiryText = `login session expires in ${sessionDaysLeft}d — refresh soon`;
    } else {
      expiryText = `login session fresh (~${sessionDaysLeft}d left)`;
    }
  } else if (hasLoginSession) {
    expiryText = "session cookies have no expiry (session-only) — valid while the browser session lives";
  } else {
    expiryText = "no login session found";
  }
  const base = (s: Partial<CookieStatus>): CookieStatus => ({ ...empty, ...s });
  let detail: string;
  let valid = true;
  if (rows.length === 0) {
    detail = "file exists but has NO cookies (empty?) — re-export it";
    valid = false;
  } else if (yt.length === 0) {
    detail = `${rows.length} cookies but NONE for youtube.com — export while on youtube.com, logged in`;
    valid = false;
  } else if (!hasLoginSession) {
    detail = `${rows.length} cookies (${yt.length} for youtube.com) but NO login session (SID/LOGIN_INFO missing) — export while LOGGED IN at youtube.com`;
    valid = false;
  } else if (expired > 0 && expired >= yt.length / 2) {
    detail = `${yt.length} youtube cookies, but ${expired} are EXPIRED — re-export fresh cookies`;
    valid = false;
  } else {
    const kb = (Buffer.byteLength(raw, "utf8") / 1024).toFixed(1);
    detail = `${rows.length} cookies (${yt.length} for youtube.com, ${kb} KB)`;
    if (expired > 0) detail += `, ${expired} expired`;
    if (expiring > 0) detail += `, ${expiring} expire within 7 days`;
  }
  return base({
    total: rows.length, youtube: yt.length,
    expiredYoutube: expired, expiringSoon: expiring,
    hasLoginSession, valid, detail, sessionDaysLeft, expiryText,
  });
}

/** Save fresh cookies text to disk (used by env restore + Telegram upload). No restart needed. */
export function saveCookiesContent(raw: string): CookieStatus {
  const status = validateCookiesContent(raw);
  const dir = path.dirname(config.cookiesPath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // Keep one backup so a bad upload never destroys the last working file.
    try {
      if (fs.existsSync(config.cookiesPath)) {
        fs.copyFileSync(config.cookiesPath, `${config.cookiesPath}.bak`);
      }
    } catch {}
    const normalized = raw.trim().endsWith("\n") ? raw.trim() + "\n" : raw.trim() + "\n";
    fs.writeFileSync(config.cookiesPath, normalized, "utf8");
  } catch (err: any) {
    throw new Error(`❌ Could not save cookies file (${config.cookiesPath}): ${err?.message || err}`);
  }
  if (!status.valid) {
    console.warn(`⚠️ Saved cookies look invalid: ${status.detail} (previous file kept at ${config.cookiesPath}.bak)`);
  } else {
    console.log(`✅ Cookies saved to ${config.cookiesPath} (${status.detail}; ${status.expiryText}) — applies to the next download, no restart needed.`);
  }
  return status;
}

/**
 * Render / Docker have ephemeral filesystems: a cookies.txt uploaded through
 * the dashboard shell vanishes on the next restart/redeploy. If COOKIES_CONTENT
 * is set, restore the file from it on every boot so sessions survive restarts.
 */
export function ensureCookiesFromEnv(): void {
  if (config.cookiesFromBrowser || !config.cookiesContent) return;
  const decoded = decodeCookiesEnv(config.cookiesContent);
  if (!decoded) {
    console.warn(
      "⚠️ COOKIES_CONTENT is set but could not be decoded (expected raw Netscape text or base64). Ignoring it."
    );
    return;
  }
  try {
    let current = "";
    try {
      current = fs.readFileSync(config.cookiesPath, "utf8");
    } catch {}
    if (current.trim() === decoded.trim()) {
      console.log("🔧 Cookies: COOKIES_CONTENT matches cookies file, nothing to restore.");
      return;
    }
    const status = saveCookiesContent(decoded);
    console.log(`🔧 Cookies: restored from COOKIES_CONTENT env var (${status.detail}).`);
  } catch (err: any) {
    console.warn(`⚠️ Failed to restore cookies from COOKIES_CONTENT: ${err?.message || err}`);
  }
}

/** Public status for the /cookies admin command. */
export function getCookiesStatus(): CookieStatus {
  if (config.cookiesFromBrowser) {
    return {
      source: "browser", path: config.cookiesFromBrowser, total: -1, youtube: -1,
      expiredYoutube: 0, expiringSoon: 0, hasLoginSession: true, valid: true,
      detail: `reading from browser "${config.cookiesFromBrowser}"`,
      sessionDaysLeft: null, expiryText: "managed by the browser — refresh by re-logging in there",
    };
  }
  try {
    const raw = fs.readFileSync(config.cookiesPath, "utf8");
    const s = validateCookiesContent(raw);
    s.source = config.cookiesContent ? "env" : "file";
    return s;
  } catch {
    return {
      source: "none", path: config.cookiesPath, total: 0, youtube: 0,
      expiredYoutube: 0, expiringSoon: 0, hasLoginSession: false, valid: false,
      detail: `no cookies file at ${config.cookiesPath}`,
      sessionDaysLeft: null, expiryText: "no cookies installed",
    };
  }
}

/** Log yt-dlp / cookies / runtime status at startup so the admin sees problems early. */
export function logDownloaderDiagnostics(): void {
  const version = getYtDlpVersion();
  const age = ytDlpAgeDays();
  console.log(`🔧 yt-dlp version: ${version ?? "NOT FOUND"}${age !== null ? ` (${age}d old)` : ""}`);
  if (age !== null && age > 14) {
    console.warn(
      `⚠️ yt-dlp build is ${age} days old — YouTube changes its player constantly and builds older than ~2 weeks fail on their own. ` +
        `Redeploy on Render now (build installs fresh nightly), or set YTDLP_AUTO_UPDATE=true for self-update on boot.`
    );
  }
  console.log(
    hasNodeRuntime()
      ? "🔧 JS runtime: node available (YouTube JS challenges enabled)"
      : "⚠️ JS runtime: node NOT found on PATH — YouTube extraction will be degraded"
  );
  console.log(
    supportsImpersonate()
      ? "🔧 Browser impersonation: supported"
      : "⚠️ Browser impersonation: not supported by this yt-dlp build (TikTok may fail more often)"
  );
  if (config.cookiesFromBrowser) {
    console.log(`🔧 Cookies: reading from browser "${config.cookiesFromBrowser}"`);
  } else if (hasCookies()) {
    const status = getCookiesStatus();
    console.log(`🔧 Cookies: using file ${config.cookiesPath} (${status.detail}; ${status.expiryText})`);
    if (!status.valid) {
      console.warn(`⚠️ Cookies look INVALID: ${status.detail}. Cookie-only videos will fail until fresh cookies are uploaded (send cookies.txt to the bot, no restart needed).`);
    } else if (status.sessionDaysLeft !== null && status.sessionDaysLeft <= 7) {
      console.warn(`⚠️ ${status.expiryText} — plan a refresh soon (send a fresh cookies.txt to the bot).`);
    } else if (status.expiringSoon > 0) {
      console.warn(`⚠️ ${status.expiringSoon} YouTube cookies expire within 7 days — plan a refresh soon (send a fresh cookies.txt to the bot).`);
    }
    if (!config.cookiesContent && process.env.RENDER_EXTERNAL_URL) {
      console.warn(
        "⚠️ Running on Render without COOKIES_CONTENT: cookies.txt will be LOST on the next restart/redeploy. " +
          "Paste the file into the COOKIES_CONTENT env var to make it persistent."
      );
    }
  } else {
    console.log(
      `🔧 Cookies: none configured — YouTube runs cookie-free (anonymous clients first). ` +
        `Most public videos work; age-gated/private ones need cookies (send cookies.txt to the bot).`
    );
  }
  console.log(`🔧 YouTube mode: yt-dlp PRIMARY + HTTPS fallbacks — yt-dlp ${config.youtubeYtdlpFirst ? "first" : "last"} (${config.youtubeYtdlpFallback ? "ON" : "OFF"}) → Cobalt → youtubei → Piped → Invidious, max-height=${config.youtubeMaxHeight === 0 ? "uncapped" : config.youtubeMaxHeight + "p"}`);
  if (config.ytDlpExtraArgs.length > 0) console.log(`🔧 yt-dlp extra args: ${config.ytDlpExtraArgs.join(" ")}`);
  if (config.potServerUrl) console.log(`🔧 PO-token provider: ${config.potServerUrl} (bgutil plugin required)`);
  console.log(
    config.invidiousEnabled
      ? `⚡ YouTube: Invidious ENABLED (${config.invidiousInstances.length} configured + live refresh ${config.invidiousRefresh ? "on" : "off"})`
      : "⚡ YouTube: Invidious disabled (INVIDIOUS_ENABLED=false)"
  );
  console.log(
    config.pipedEnabled
      ? `⚡ YouTube: Piped ENABLED (${config.pipedInstances.length} configured + live refresh ${config.pipedRefresh ? "on" : "off"}, primary public path)`
      : "⚡ YouTube: Piped disabled (PIPED_ENABLED=false)"
  );
  console.log(
    isCobaltConfigured()
      ? `⚡ Fast path: Cobalt API configured (${config.cobaltApiUrl}, tried first for all platforms)`
      : "⚡ Fast path: Cobalt API not configured (set COBALT_API_URL to your self-hosted instance to enable)"
  );
  console.log(
    hasAria2c()
      ? "🔧 Downloader: aria2c available (8-connection fast downloads enabled)"
      : "🔧 Downloader: native (install aria2c for faster progressive-mp4 downloads)"
  );
  console.log(
    getFfmpegVersion()
      ? `🔧 ffmpeg: available (${getFfmpegVersion()}, H.264 encoder: ${hasLibx264() ? "libx264" : "mpeg4-fallback"})`
      : "⚠️ ffmpeg: NOT FOUND — HLS-only Pinterest videos will fall back to cover images and Pinterest MP4s ship un-normalized (build.sh installs a static build on Linux)"
  );
  if (config.ytDlpProxy) console.log("🔧 Proxy: YT_DLP_PROXY is set (YouTube traffic routed via proxy)");
  else if (process.env.RENDER_EXTERNAL_URL || process.env.RENDER)
    console.log("🔧 Proxy: none (datacenter IP — if YouTube hard-blocks it, set YT_DLP_PROXY to a residential proxy)");
  console.log(
    config.tiktokFallback
      ? "🔧 TikTok fallback providers: enabled (tikwm x2 + ssstik, retried with UA rotation)"
      : "🔧 TikTok fallback providers: disabled (TIKTOK_FALLBACK=false)"
  );
  console.log(
    `🔧 Stability: max ${config.maxConcurrentDownloads} concurrent download(s), ` +
      `per-download budget ${Math.round(config.downloadTimeoutMs / 1000)}s, ` +
      `yt-dlp attempt timeout ${Math.round(config.ytDlpAttemptTimeoutMs / 1000)}s, ` +
      `public-API timeout ${Math.round(config.publicApiTimeoutMs / 1000)}s`
  );
}

const AUDIO_EXTENSIONS = new Set(["m4a", "mp3", "ogg", "opus", "wav", "aac", "flac", "wma"]);

const TIKTOK_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Rotating UAs: providers fingerprint per (IP, UA) — a blocked UA often passes with another. */
const TIKTOK_UAS = [
  TIKTOK_UA,
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
];

function tikTokUa(seed: number): string {
  return TIKTOK_UAS[Math.abs(seed) % TIKTOK_UAS.length];
}

let _hasAria2c: boolean | null = null;
/** aria2c with 8 connections downloads progressive mp4s much faster than native. */
function hasAria2c(): boolean {
  if (_hasAria2c === null) {
    try {
      execSync("aria2c --version", { stdio: "ignore" });
      _hasAria2c = true;
    } catch {
      _hasAria2c = false;
    }
  }
  return _hasAria2c;
}

/** Extra yt-dlp args derived from local capabilities: auth cookies + JS runtime. */
function buildCommonArgs(useCookies = true, chunked = true): string[] {
  const args: string[] = [];
  const cookieMode = config.youtubeCookieMode;
  const wantCookies = useCookies && cookieMode !== "never";
  if (wantCookies) {
    if (config.cookiesFromBrowser) {
      args.push("--cookies-from-browser", config.cookiesFromBrowser);
      console.log(`✅ Using cookies from browser: ${config.cookiesFromBrowser}`);
    } else if (fs.existsSync(config.cookiesPath)) {
      args.push("--cookies", config.cookiesPath);
      console.log(`✅ Using cookies from: ${config.cookiesPath}`);
    } else {
      console.warn(`⚠️ Cookie file not found at: ${config.cookiesPath} (trying without cookies)`);
    }
  }
  // Optional residential proxy — the only fix when the datacenter IP itself is flagged.
  if (config.ytDlpProxy) args.push("--proxy", config.ytDlpProxy);
  // Render/IPv6 egress is frequently the flagged path; IPv4 still passes.
  if (config.ytDlpForceIpv4) args.push("--force-ipv4");
  // Optional PO-token sidecar (bgutil plugin): makes web/mweb clients look
  // legitimate on flagged IPs. Only wired when POT_SERVER_URL is set AND the
  // plugin is installed; otherwise ignored harmlessly.
  if (config.potServerUrl) {
    args.push("--extractor-args", `youtubepot-bgutilhttp:base_url=${config.potServerUrl}`);
  }
  // Lets yt-dlp solve YouTube JS challenges instead of degrading extraction.
  if (hasNodeRuntime()) args.push("--js-runtimes", "node");
  // Speed: chunked HTTP bypasses per-connection throttling on progressive mp4s;
  // parallel fragments help DASH/HLS; short timeouts + few retries fail over
  // to the next player client fast instead of stalling on a blocked one.
  // NOTE: chunking is opt-out per attempt — v1.pinimg.com answers ranged
  // requests to small HLS segments with garbage ("Conflicting range"), so
  // Pinterest runs unchunked.
  args.push(
    "--concurrent-fragments", "8",
    "--buffer-size", "16K",
    "--socket-timeout", "10",
    "--retries", "3",
    "--fragment-retries", "3",
    "--no-check-certificates"
  );
  if (chunked) args.push("--http-chunk-size", "10M");
  // aria2c (8 connections) is far faster than the native downloader for
  // progressive http mp4s, when it is installed. Probe once, use if present.
  if (hasAria2c()) {
    args.push(
      "--downloader", "aria2c",
      "--downloader-args", "aria2c:-x 8 -s 8 -k 1M --min-split-size=1M"
    );
  }
  // Admin escape hatch: raw extra args (e.g. sleep/throttle tuning).
  if (config.ytDlpExtraArgs.length > 0) args.push(...config.ytDlpExtraArgs);
  return args;
}

interface AttemptSpec {
  name: string;
  extraArgs: string[];
  /** false = run WITHOUT any cookies (anonymous clients that ignore/reject them). */
  useCookies: boolean;
  /** false = skip --http-chunk-size (breaks small HLS segments on some hosts). */
  chunked?: boolean;
}

/**
 * Per-platform yt-dlp strategy chains.
 *
 * NOTE: YouTube has its OWN yt-dlp fallback (youtubeYtdlp.ts, wired as the
 * final step of the YouTube pipeline in youtube.ts), so there is no
 * "youtube" entry here. Pinterest tries direct scraping first
 * (pinterest.ts) and only falls back to yt-dlp below.
 */
function attemptsFor(platform: string): AttemptSpec[] {
  if (platform === "youtube") {
    // Unused — YouTube is handled by downloadYouTubeCookieFree() (which ends
    // with its own yt-dlp fallback in youtubeYtdlp.ts). Kept as a guard so a
    // future caller can't silently route YouTube through this generic chain.
    return [];
  }
  if (platform === "tiktok") {
    // Three independent draws: impersonated TLS (defeats most IP/UA walls),
    // plain yt-dlp with cookies, then fully anonymous. Cookies sometimes HURT
    // (a stale session redirects to login where anonymous passes), so the
    // anonymous attempt stays even when cookies exist.
    const attempts: AttemptSpec[] = [];
    if (supportsImpersonate()) {
      attempts.push({
        name: "impersonate",
        extraArgs: ["--impersonate", "chrome", "-f", "b[ext=mp4]/b"],
        useCookies: true,
      });
    }
    attempts.push({ name: "default", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: true });
    if (hasCookies() && config.youtubeCookieMode !== "never") {
      attempts.push({ name: "anonymous", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: false });
    }
    return attempts;
  }
  if (platform === "instagram" || platform === "twitter") {
    // Same idea: impersonation first (TLS fingerprint is the usual block),
    // then cookies, then anonymous — Instagram/Twitter rate-limit logged-in
    // sessions aggressively, so anonymous is a genuinely different route.
    const attempts: AttemptSpec[] = [];
    if (supportsImpersonate()) {
      attempts.push({
        name: "impersonate",
        extraArgs: ["--impersonate", "chrome", "-f", "b[ext=mp4]/b"],
        useCookies: true,
      });
    }
    attempts.push({ name: "default", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: true });
    if (hasCookies() && config.youtubeCookieMode !== "never") {
      attempts.push({ name: "anonymous", extraArgs: ["-f", "b[ext=mp4]/b"], useCookies: false });
    }
    return attempts;
  }
  if (platform === "pinterest") {
    // Progressive MP4 first (single file, no merge). HLS-only story pins
    // expose split video-only/audio-only tracks, so fall back to a merge
    // (needs ffmpeg — installed at build time, see build.sh). Unchunked:
    // ranged requests break v1.pinimg.com HLS segment downloads.
    return [{ name: "default", extraArgs: ["-f", "b[ext=mp4]/bv*+ba/b"], useCookies: true, chunked: false }];
  }
  return [{ name: "default", extraArgs: ["-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best"], useCookies: true }];
}

/** Errors where retrying another strategy (or fallback) is pointless. */
function isFatalError(msg: string): boolean {
  return (
    msg.includes("Unsupported URL") ||
    msg.includes("Video unavailable") ||
    msg.includes("Private video") ||
    msg.includes("This video is private") ||
    msg.includes("max-filesize") ||
    msg.includes("File is larger than") ||
    msg.includes("Requested format is not available")
  );
}

function isYouTubeBotCheck(msg: string): boolean {
  return (
    /Sign in to confirm you.{0,10}re not a bot/i.test(msg) ||
    /not a bot/i.test(msg) ||
    /LOGIN_REQUIRED/.test(msg) ||
    /The page needs to be reloaded/i.test(msg) ||
    /confirm your age/i.test(msg) ||
    /use --cookies/i.test(msg)
  );
}

function isTikTokBlock(msg: string): boolean {
  return (
    msg.includes("Your IP address is blocked") ||
    msg.includes("Unexpected response from webpage") ||
    /HTTP 429|Too Many Requests|rate-limit/i.test(msg) ||
    /TikTok.*(blocked|denied|capital|verify)/i.test(msg)
  );
}

/** Run one yt-dlp attempt: hard timeout + bounded buffers (hang/memory safety). */
function runYtDlpAttempt(
  args: string[],
  onProgress?: (p: DownloadProgress) => void
): Promise<string> {
  const timeoutMs = config.ytDlpAttemptTimeoutMs;
  const MAX_BUF = 512 * 1024; // 512KB cap per stream
  return new Promise((resolve, reject) => {
    const proc = spawn(config.ytDlpPath, args, { shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch {}
      reject(new Error(`yt-dlp attempt timed out after ${Math.round(timeoutMs / 1000)}s (network stall or blocked client)`));
    }, timeoutMs);
    const append = (target: string, s: string): string => {
      if (target.length >= MAX_BUF) return target;
      const next = target + s;
      return next.length > MAX_BUF ? next.slice(-MAX_BUF) : next;
    };

    proc.stdout.on("data", (d: Buffer) => {
      const s = d.toString();
      stdout = append(stdout, s);
      const m = s.match(/(\d+\.\d+)%/);
      if (m && onProgress) onProgress({ percent: parseFloat(m[1]) });
    });

    proc.stderr.on("data", (d: Buffer) => {
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
      if (code !== 0) {
        return reject(new Error(stderr || stdout || `yt-dlp exited with code ${code}`));
      }
      resolve(stdout);
    });
  });
}

/** Turn `--print after_move:filepath` output (or a dir scan) into a validated video file. */
function resolveDownloadedFile(stdout: string, id: string, platform: string): DownloadResult {
  // Parse --print after_move:filepath output
  // When DASH merge fails (no ffmpeg), yt-dlp outputs MULTIPLE lines (video + audio)
  // We must pick the .mp4 line, NOT the .m4a line
  const lines = stdout.trim().split("\n").map((l) => l.trim()).filter(Boolean);

  // Prefer .mp4 files from the output lines
  let filePath = lines.find((l) => l.endsWith(".mp4"));

  // If no .mp4 found, take the last line (usually the merged result)
  if (!filePath) {
    filePath = lines[lines.length - 1];
  }

  // Fallback: glob download dir for newest .mp4 file with id prefix
  if (!filePath || !fs.existsSync(filePath)) {
    const files = fs.readdirSync(config.downloadDir)
      .filter((f) => f.startsWith(id + "_") && f.endsWith(".mp4"))
      .map((f) => path.join(config.downloadDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (files.length > 0) filePath = files[0];
  }

  // Last fallback: any file with id prefix
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

  // GUARD: reject audio-only files
  if (AUDIO_EXTENSIONS.has(ext)) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error(
      `❌ yt-dlp returned an audio file (.${ext}) instead of video. ` +
      `This URL may not have a downloadable video. Try a different link.`
    );
  }

  const stat = fs.statSync(filePath);
  return { filePath, fileName: path.basename(filePath), ext, size: stat.size, platform };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "video";
}

/** Thrown when a provider confirms the video itself is gone — no point trying other providers. */
class VideoNotFoundError extends Error {}

interface TikTokResolved {
  playUrl: string;
  title?: string;
  source: string;
}

const VIDEO_NOT_FOUND_MSG =
  "❌ TikTok video not found. It may be private, deleted, or the link is wrong.";

/** GET JSON with timeout + retries (backoff) + UA rotation for transient blips. */
async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 30000, retries = 2): Promise<any> {
  let lastError = "";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const ua = attempt === 1 ? headers["User-Agent"] : tikTokUa(attempt + url.length);
      const res = await fetch(url, { headers: { ...headers, "User-Agent": ua }, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err: any) {
      lastError = err?.name === "AbortError" ? "timed out" : (err?.message || String(err));
      console.warn(`⚠️ GET ${url.slice(0, 60)}… attempt ${attempt}/${retries} failed: ${lastError.slice(0, 120)}`);
      if (attempt < retries) await new Promise((r) => setTimeout(r, attempt * 2000));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(lastError || "request failed");
}

/** tikwm JSON API resolver (used with two independent hosts). */
async function resolveViaTikwm(apiBase: string, videoUrl: string): Promise<TikTokResolved> {
  const info = await fetchJson(
    `${apiBase}/api/?url=${encodeURIComponent(videoUrl)}`,
    { "User-Agent": TIKTOK_UA }
  );
  if (info?.code !== 0 || !info?.data) {
    console.warn(`tikwm (${apiBase}) error: code=${info?.code} msg=${info?.msg}`);
    // tikwm answers code != 0 for bad/deleted/private videos — other providers
    // will fail the same way, so short-circuit with a clear message.
    throw new VideoNotFoundError(VIDEO_NOT_FOUND_MSG);
  }
  // Prefer the no-watermark mp4, fall back to watermarked.
  const playUrl: string | undefined = info.data.play || info.data.wmplay;
  if (!playUrl) throw new VideoNotFoundError(VIDEO_NOT_FOUND_MSG);
  return { playUrl, title: info.data.title, source: `tikwm@${apiBase}` };
}

/**
 * ssstik.io resolver (fully independent provider).
 * GET /en (grab s_tt token + cookies) → POST /abc?url=dl → parse download link.
 * Retried once with a rotated UA — ssstik rate-limits per (IP, UA) and the
 * token page layout drifts, so both the fetch AND the parse are retried.
 */
async function resolveViaSsstik(videoUrl: string): Promise<TikTokResolved> {
  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const ua = tikTokUa(attempt + videoUrl.length);
      const pageRes = await fetch("https://ssstik.io/en", { headers: { "User-Agent": ua } });
      if (!pageRes.ok) throw new Error(`ssstik page HTTP ${pageRes.status}`);
      const html = await pageRes.text();
      const token = html.match(/s_tt\s*=\s*'([^']+)'/)?.[1] || html.match(/s_tt\s*=\s*"([^"]+)"/)?.[1];
      if (!token) throw new Error("ssstik token not found (page layout changed?)");
      const cookies = [...pageRes.headers.getSetCookie()].map((c) => c.split(";")[0]).join("; ");

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      let resultHtml = "";
      try {
        const res = await fetch("https://ssstik.io/abc?url=dl", {
          method: "POST",
          headers: {
            "User-Agent": ua,
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            Origin: "https://ssstik.io",
            Referer: "https://ssstik.io/en",
            Cookie: cookies,
          },
          body: new URLSearchParams({ id: videoUrl, locale: "en", tt: token }).toString(),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`ssstik resolve HTTP ${res.status}`);
        resultHtml = await res.text();
      } finally {
        clearTimeout(timeout);
      }
      // No-watermark link: double- or single-quoted href, or data-href attr.
      const unescaped = resultHtml.replace(/\\\//g, "/");
      const playUrl =
        [...unescaped.matchAll(/href="(https:[^"]+)"/g)].map((m) => m[1])[0] ||
        [...unescaped.matchAll(/href='(https:[^']+)'/g)].map((m) => m[1])[0] ||
        [...unescaped.matchAll(/data-href="(https:[^"]+)"/g)].map((m) => m[1])[0];
      if (!playUrl) {
        console.warn(`ssstik returned no download link (len=${resultHtml.length})`);
        throw new VideoNotFoundError(VIDEO_NOT_FOUND_MSG);
      }
      return { playUrl, source: "ssstik" };
    } catch (err: any) {
      if (err instanceof VideoNotFoundError) throw err;
      lastError = err?.message || String(err);
      console.warn(`⚠️ ssstik attempt ${attempt}/2 failed: ${lastError.slice(0, 120)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(lastError || "ssstik failed");
}

/** Stream a remote mp4 to disk with max-size enforcement. */
async function downloadFileTo(
  fileUrl: string,
  filePath: string,
  referer: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<void> {
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(fileUrl, {
      headers: { "User-Agent": TIKTOK_UA, Referer: referer },
      signal: controller.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Video server HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length") || 0);
    if (total > maxBytes) {
      throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
    }
    const file = fs.createWriteStream(filePath);
    let received = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        if (received > maxBytes) {
          file.destroy();
          try { fs.unlinkSync(filePath); } catch {}
          throw new Error(`❌ Video too large (>${config.maxFileSizeMB}MB). Try a shorter video.`);
        }
        if (!file.write(chunk)) await new Promise<void>((r) => file.once("drain", r));
        if (total > 0 && onProgress) onProgress({ percent: (received / total) * 100 });
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        file.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    }
  } catch (err: any) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    if (err?.name === "AbortError") throw new Error("❌ TikTok download timed out. Please try again.");
    throw err instanceof Error ? err : new Error(`❌ TikTok download failed: ${err}`);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * TikTok fallback: when yt-dlp is blocked (TikTok frequently blocks server IPs
 * or breaks the extractor with API changes), resolve the direct mp4 through
 * independent third-party providers and download it with plain HTTPS.
 */
async function downloadTikTokFallback(
  url: string,
  id: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  console.log("🎵 yt-dlp failed for TikTok, trying fallback providers…");
  const providers: Array<{ name: string; run: () => Promise<TikTokResolved> }> = [
    { name: "tikwm.com", run: () => resolveViaTikwm("https://www.tikwm.com", url) },
    { name: "tikwm-apex", run: () => resolveViaTikwm("https://tikwm.com", url) },
    { name: "ssstik", run: () => resolveViaSsstik(url) },
  ];

  let resolved: TikTokResolved | null = null;
  const failures: string[] = [];
  for (const p of providers) {
    try {
      console.log(`🎵 TikTok fallback provider: ${p.name}…`);
      resolved = await p.run();
      console.log(`✅ TikTok resolved via ${resolved.source}`);
      break;
    } catch (err: any) {
      // Video is gone, or a decisive error (e.g. too large) — don't hammer other providers.
      if (err instanceof VideoNotFoundError || err?.message?.startsWith("❌")) throw err;
      const msg = err?.message || String(err);
      console.warn(`⚠️ TikTok provider ${p.name} failed: ${msg.slice(0, 150)}`);
      failures.push(`${p.name}: ${msg.slice(0, 100)}`);
      // Brief pause between providers: hammering all three back-to-back from
      // one datacenter IP looks like a bot burst and gets the IP throttled.
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  if (!resolved) {
    console.error(`❌ All TikTok fallback providers failed: ${failures.join(" | ")}`);
    const rateLimited = failures.some((f) => /429|Too Many|blocked|denied|capital|verify|timed out/i.test(f));
    throw new Error(
      rateLimited
        ? "❌ TikTok is rate-limiting this server right now (its anti-bot blocks datacenter IPs per-video and temporarily). " +
          "Please wait a few minutes and try again, or try another link."
        : "❌ TikTok is unreachable right now (its anti-bot blocks this server's network on every route). " +
          "Please try again in a few minutes or try another link."
    );
  }

  const fileName = `${id}_${sanitizeFileName(resolved.title || "tiktok")}.mp4`;
  const filePath = path.join(config.downloadDir, fileName);
  await downloadFileTo(resolved.playUrl, filePath, "https://www.tiktok.com/", onProgress);

  const stat = fs.statSync(filePath);
  if (stat.size === 0) {
    try { fs.unlinkSync(filePath); } catch {}
    throw new Error("❌ TikTok fallback returned an empty file. Try another link.");
  }
  console.log(`✅ TikTok fallback saved: ${fileName} (${(stat.size / 1048576).toFixed(1)} MB)`);
  return { filePath, fileName, title: resolved.title, ext: "mp4", size: stat.size, platform: "tiktok" };
}

/** Map raw yt-dlp output to short, actionable user-facing errors. */
function mapDownloadError(msg: string, platform: string): Error {
  if (msg.includes("Unsupported URL")) {
    return new Error("❌ Unsupported URL. Make sure the link is a public video.");
  }
  if (msg.includes("Video unavailable") || msg.includes("Private video") || msg.includes("This video is private")) {
    return new Error("❌ Video unavailable or private.");
  }
  if (isTooLargeMessage(msg)) {
    return new Error(`❌ Video too large (>${config.maxFileSizeMB}MB even at the lowest quality). Try a shorter video.`);
  }
  if (msg.includes("Requested format is not available")) {
    return new Error("❌ This video has no downloadable format (it may be a live stream, premiere, or DRM-protected). Try another link.");
  }
  if (/timed out|timed out after|network stall/i.test(msg)) {
    return new Error(
      "❌ Download timed out (the video server is slow or blocking this region right now).\n\n" +
        "Please try again in a few minutes."
    );
  }
  if (/HTTP 429|Too Many Requests|rate-limit|rate limited/i.test(msg)) {
    return new Error(
      `❌ ${platform} is rate-limiting this server right now (too many requests from one IP).\n\n` +
        "Please wait a few minutes and try again."
    );
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|network is unreachable/i.test(msg)) {
    return new Error(
      "❌ Network error reaching the video server (DNS/connection failed).\n\n" +
        "Please try again in a minute."
    );
  }
  if (/No space left|ENOSPC|disk/i.test(msg)) {
    console.error(`❌ Disk full while downloading: ${msg.slice(0, 200)}`);
    return new Error("❌ Server storage is full — the admin needs to clear the downloads folder. Try again later.");
  }
  if (platform === "youtube" && isYouTubeBotCheck(msg)) {
    // YouTube no longer uses yt-dlp/cookies — this branch only fires if a
    // provider echoed YouTube's own bot-wall text inside its error payload.
    console.error("❌ YouTube provider reported a bot-check/login wall for this video.");
    return new Error(
      "❌ YouTube blocked this download on every cookie-free provider (Cobalt, Invidious, Piped).\n\n" +
      "Most public videos work — this one is likely age-restricted, private, or all public " +
      "instances are rate-limited right now. Wait a few minutes and retry, or try a different video.\n\n" +
      "🔧 Admin: for maximum reliability, self-host a Cobalt instance (ghcr.io/imputnet/cobalt) and set COBALT_API_URL."
    );
  }
  if (platform === "tiktok" && isTikTokBlock(msg)) {
    return new Error(
      "❌ TikTok blocked this download (anti-bot rate-limit on this server's network, or the video is private/deleted). " +
      "Wait a few minutes and try again, or try another link."
    );
  }
  if (platform === "youtube" && msg.includes("Failed to extract any player response")) {
    // A provider returned no playable data for this video.
    console.error(`❌ YouTube returned no player response for this video (all providers failed).`);
    return new Error(
      "❌ YouTube returned no playable data for this video.\n\n" +
      "Most likely the video is login-walled (age-restricted/private — hidden from " +
      "anonymous APIs) or every public instance is rate-limited right now. " +
      "Wait a few minutes and retry, or try a different public video."
    );
  }
  return new Error(`❌ Download failed:\n${msg.slice(0, 800)}`);
}

/**
 * Download media from a supported URL.
 * - YouTube: yt-dlp PRIMARY (per-client rotation, cookies/proxy), HTTPS
 *   pipelines as fallback (Cobalt → Piped → Invidious → youtubei
 *   multi-client) — see youtube.ts.
 * - Pinterest: direct scraping (no login/cookies), yt-dlp as fallback.
 * - TikTok / X-Twitter / Instagram: yt-dlp (+ TikTok fallback providers).
 * Returns the path to the downloaded file (mp4, or image for Pinterest pins).
 */
export async function downloadVideo(
  url: string,
  onProgress?: (p: DownloadProgress) => void
): Promise<DownloadResult> {
  ensureDownloadDir();

  const platform = detectPlatform(url);

  // --- YouTube: yt-dlp first, HTTPS pipelines as fallback (see youtube.ts) --
  if (platform === "youtube") {
    return downloadYouTubeCookieFree(url, onProgress);
  }

  // --- Pinterest: direct scraping first (no login/cookies needed) -----------
  // NOTE: an UNCERTAIN image result is kept as a fallback while the video
  // pipeline (Cobalt → yt-dlp) still runs — video pins used to be mis-saved
  // as their cover thumbnail when video extraction missed. API-verified image
  // pins (confidentImage) return immediately with no yt-dlp round-trip.
  let pinterestImageFallback: DownloadResult | null = null;
  if (platform === "pinterest") {
    try {
      console.log("📌 Trying direct Pinterest download…");
      const direct = await downloadPinterest(url, onProgress);
      if (direct.ext.toLowerCase() === "mp4") return normalizePinterestMp4(direct);
      if (direct.confidentImage) {
        console.log("📌 Pinterest image pin — returning image directly.");
        return direct;
      }
      console.log("📌 Direct Pinterest returned an image — trying video methods before accepting it…");
      pinterestImageFallback = direct;
    } catch (err: any) {
      // HLS-only / external-embed pins: direct download saved the cover image
      // and attached it — keep it while yt-dlp tries for the real video.
      if (err?.pinterestImageFallback) {
        console.log("📌 Pinterest video needs yt-dlp — cover image kept as fallback…");
        pinterestImageFallback = err.pinterestImageFallback;
      }
      // Definitive failures (gone/private/too large): don't waste time on yt-dlp.
      if (err?.message?.startsWith("❌")) {
        const msg = String(err.message);
        if (/not found|private|deleted|Could not find|too large/i.test(msg)) throw err;
      }
      console.warn(`⚠️ Pinterest direct failed, falling back to yt-dlp: ${(err?.message || String(err)).slice(0, 150)}`);
    }
    // …fall through to the video pipeline below.
  }

  // --- Fast path: Cobalt API (TikTok/X/Instagram/Pinterest fallback).
  // Single direct MP4, no ffmpeg merge — fastest when a self-hosted instance
  // is configured via COBALT_API_URL.
  if (isCobaltConfigured()) {
    try {
      console.log(`⚡ Trying fast path: Cobalt (${platform})…`);
      const fast = await downloadViaCobalt(url, platform, onProgress);
      if (fast) {
        if (pinterestImageFallback && pinterestImageFallback.filePath !== fast.filePath) {
          try { fs.unlinkSync(pinterestImageFallback.filePath); } catch {}
          pinterestImageFallback = null;
        }
        if (platform === "pinterest" && fast.ext.toLowerCase() === "mp4") return normalizePinterestMp4(fast);
        return fast;
      }
    } catch (err: any) {
      if (err?.message?.startsWith("❌")) throw err; // definitive (gone/too large)
      console.warn(`⚠️ Cobalt fast path failed, continuing: ${(err?.message || String(err)).slice(0, 150)}`);
    }
  }

  if (!checkYtDlp()) {
    throw new Error(
      `yt-dlp not found at "${config.ytDlpPath}". Install it: https://github.com/yt-dlp/yt-dlp#installation`
    );
  }

  const id = crypto.randomBytes(6).toString("hex");
  const template = path.join(config.downloadDir, `${id}_%(title).100s.%(ext)s`);

  const baseArgs: string[] = [
    "--no-playlist",
    "--no-warnings",
    "--merge-output-format",
    "mp4",
    "--ffmpeg-location",
    config.ffmpegDir,
    "--downloader-args",
    "ffmpeg:-threads 0", // use all CPU cores for ffmpeg merge
    "--max-filesize",
    `${config.maxFileSizeMB}M`,
    "-o",
    template,
    "--no-mtime",
  ];

  const attempts = attemptsFor(platform);
  let lastError = "";
  const allErrors: string[] = [];
  let retriedLower = false;
  for (const attempt of attempts) {
    // Cookies are attached per-attempt: cookie-respecting clients get them,
    // anonymous clients run WITHOUT them (some ignore cookies, and pairing
    // cookies+tv can even invalidate the saved session).
    const args = [
      ...baseArgs,
      ...buildCommonArgs(attempt.useCookies, attempt.chunked !== false),
      ...attempt.extraArgs,
      "--print",
      "after_move:filepath",
      url,
    ];
    try {
      if (attempts.length > 1)
        console.log(
          `⏳ Trying ${platform} strategy: ${attempt.name}${attempt.useCookies ? " (cookies)" : " (no cookies)"}…`
        );
      const stdout = await runYtDlpAttempt(args, onProgress);
      const resolved = resolveDownloadedFile(stdout, id, platform);
      if (pinterestImageFallback && pinterestImageFallback.filePath !== resolved.filePath) {
        try { fs.unlinkSync(pinterestImageFallback.filePath); } catch {}
        pinterestImageFallback = null;
      }
      if (platform === "pinterest" && resolved.ext.toLowerCase() === "mp4") return normalizePinterestMp4(resolved);
      return resolved;
    } catch (err: any) {
      lastError = err?.message || String(err);
      allErrors.push(`[${attempt.name}] ${lastError}`);
      console.warn(`⚠️ ${platform} strategy "${attempt.name}" failed: ${lastError.slice(0, 200)}`);
      // Over-limit files get ONE lower-quality retry (480p cap) before we
      // call it fatal — long/high-bitrate reels often fit at 480p.
      if (isTooLargeMessage(lastError) && !retriedLower) {
        retriedLower = true;
        console.log(`⚡ ${platform} over ${config.maxFileSizeMB}MB — retrying at lower quality (≤480p)…`);
        const lowArgs = [
          ...baseArgs,
          ...buildCommonArgs(attempt.useCookies, attempt.chunked !== false),
          "-f",
          platform === "pinterest"
            ? "b[ext=mp4][height<=480]/bv*[height<=480]+ba/b[height<=480]/b"
            : "bv*[ext=mp4][height<=480]+ba[ext=m4a]/b[ext=mp4][height<=480]/b[height<=480]/b",
          "--print",
          "after_move:filepath",
          url,
        ];
        try {
          const stdout = await runYtDlpAttempt(lowArgs, onProgress);
          const resolved = resolveDownloadedFile(stdout, id, platform);
          if (pinterestImageFallback && pinterestImageFallback.filePath !== resolved.filePath) {
            try { fs.unlinkSync(pinterestImageFallback.filePath); } catch {}
            pinterestImageFallback = null;
          }
          if (platform === "pinterest" && resolved.ext.toLowerCase() === "mp4") return normalizePinterestMp4(resolved);
          console.log(`✅ ${platform} saved at lower quality: ${resolved.fileName} (${(resolved.size / 1048576).toFixed(1)} MB)`);
          return resolved;
        } catch (lowErr: any) {
          lastError = lowErr?.message || String(lowErr);
          allErrors.push(`[lower-quality] ${lastError}`);
          console.warn(`⚠️ ${platform} lower-quality retry failed: ${lastError.slice(0, 200)}`);
        }
      }
      // Fatal errors (private/deleted/too large/unsupported) won't be fixed by another strategy.
      // Exception: a saved Pinterest image still beats an error — e.g. yt-dlp
      // reports "Requested format is not available" for image-only pins that
      // have no video formats at all.
      if (isFatalError(lastError)) {
        if (pinterestImageFallback) {
          console.log(`📌 Pinterest video unavailable (${lastError.slice(0, 80)}) — returning image fallback: ${pinterestImageFallback.fileName}`);
          return pinterestImageFallback;
        }
        throw mapDownloadError(lastError, platform);
      }
    }
  }

  // All yt-dlp strategies exhausted → TikTok has a fallback API, others get a friendly error.
  if (platform === "tiktok" && config.tiktokFallback && !isFatalError(lastError)) {
    try {
      return await downloadTikTokFallback(url, id, onProgress);
    } catch (fallbackErr: any) {
      // Fallback gives its own user-friendly message; prefer it unless it is generic.
      const msg = fallbackErr?.message || "";
      if (msg.startsWith("❌")) throw fallbackErr;
    }
  }

  // Pinterest: video pipeline failed, but direct scraping already saved the
  // pin's image — return that instead of an error (genuine image pins, or
  // video pins whose video is unreachable everywhere).
  if (pinterestImageFallback) {
    console.log(`📌 Pinterest video unavailable — returning image fallback: ${pinterestImageFallback.fileName}`);
    return pinterestImageFallback;
  }

  // Diagnose from the combined output of ALL attempts, not just the last one:
  // clients fail differently (bot-check on one, empty player response on
  // another) for the same root cause, and the last error alone misleads.
  const combinedError = allErrors.join("\n") || lastError || "yt-dlp failed without output";
  throw mapDownloadError(combinedError, platform);
}

export function cleanupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}

// NOTE: ffmpeg helpers (getFfmpegBinary/getFfmpegVersion/probeMedia) and
// normalizePinterestMp4 live in ./media so both downloader.ts and
// pinterest.ts can use them without a runtime import cycle.

/**
 * Extract the video's audio track to MP3 using ffmpeg.
 * Returns the mp3 path. Throws if the video has no audio track or ffmpeg fails.
 * Hard timeout (120s): a stuck ffmpeg would otherwise hang the bot's cleanup.
 */
export function extractAudio(videoPath: string): Promise<AudioResult> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(videoPath)) {
      return reject(new Error("Video file not found for audio extraction."));
    }
    const parsed = path.parse(videoPath);
    const audioFileName = `${parsed.name}.mp3`;
    const audioPath = path.join(parsed.dir, audioFileName);
    try {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    } catch {}

    const ffmpeg = getFfmpegBinary();
    const args = ["-y", "-i", videoPath, "-vn", "-c:a", "libmp3lame", "-q:a", "4", audioPath];
    const proc = spawn(ffmpeg, args, { shell: false });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { proc.kill("SIGKILL"); } catch {}
      try { if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath); } catch {}
      reject(new Error("⚠️ Music extraction timed out — the video was still sent."));
    }, 120000);

    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-64 * 1024);
    });
    proc.stdout.on("data", () => {});

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to run ffmpeg (${ffmpeg}): ${err.message}. Install ffmpeg: https://ffmpeg.org/download.html`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (code === 0 && fs.existsSync(audioPath)) {
          const stat = fs.statSync(audioPath);
          if (stat.size === 0) {
            try { fs.unlinkSync(audioPath); } catch {}
            return reject(new Error("⚠️ This video has no audio track, so no music file was created."));
          }
          console.log(`🎵 Audio extracted: ${audioFileName} (${(stat.size / 1048576).toFixed(2)} MB)`);
          return resolve({ filePath: audioPath, fileName: audioFileName, size: stat.size });
        }
        try {
          if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        } catch {}
        if (/does not contain any stream|Output file is empty|no audio/i.test(stderr)) {
          return reject(new Error("⚠️ This video has no audio track, so no music file was created."));
        }
        reject(new Error(`Audio extraction failed (ffmpeg exit ${code}). ${stderr.slice(-300).trim()}`));
      } catch (err: any) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

export function cleanupOldFiles(maxAgeHours = 2): void {
  try {
    if (!fs.existsSync(config.downloadDir)) return;
    const now = Date.now();
    for (const f of fs.readdirSync(config.downloadDir)) {
      const fp = path.join(config.downloadDir, f);
      try {
        const stat = fs.statSync(fp);
        if (now - stat.mtimeMs > maxAgeHours * 3600 * 1000) fs.unlinkSync(fp);
      } catch {}
    }
  } catch {}
}

/**
 * Disk-budget guard for small hosts (Render free ≈ ephemeral disk).
 * When the downloads dir exceeds `maxMB` (default 1500MB), deletes the
 * oldest files first until under budget. Runs on boot + hourly alongside
 * cleanupOldFiles. Never throws.
 */
export function enforceDiskBudget(maxMB = 1500): void {
  try {
    if (!fs.existsSync(config.downloadDir)) return;
    const entries = fs.readdirSync(config.downloadDir)
      .map((f) => {
        const fp = path.join(config.downloadDir, f);
        try {
          const stat = fs.statSync(fp);
          return stat.isFile() ? { fp, size: stat.size, mtime: stat.mtimeMs } : null;
        } catch {
          return null;
        }
      })
      .filter((e): e is { fp: string; size: number; mtime: number } => e !== null)
      .sort((a, b) => a.mtime - b.mtime);
    let total = entries.reduce((s, e) => s + e.size, 0);
    const budget = maxMB * 1024 * 1024;
    if (total <= budget) return;
    for (const e of entries) {
      try { fs.unlinkSync(e.fp); } catch {}
      total -= e.size;
      console.log(`🧹 Disk budget: removed oldest file ${path.basename(e.fp)}`);
      if (total <= budget) break;
    }
  } catch {}
}
