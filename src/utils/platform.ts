export type Platform = "tiktok" | "youtube" | "twitter" | "instagram" | "pinterest" | "unknown";

/** True for Pinterest hosts in any locale: pinterest.com, pinterest.de/.fr/.co.uk/…, and regional subdomains. */
function isPinterestHost(host: string): boolean {
  if (host === "pinterest.com" || host.endsWith(".pinterest.com")) return true;
  // Country domains: pinterest.<tld> with optional subdomains (www./m. already stripped).
  return /(^|\.)pinterest\.[a-z]{2,}(?:\.[a-z]{2,})?$/.test(host);
}

/** True for pin.it short links (exact host or subdomain). */
function isPinItHost(host: string): boolean {
  return host === "pin.it" || host.endsWith(".pin.it");
}

export function detectPlatform(url: string): Platform {
  // Hostname-based detection (avoids substring traps like "t.co" matching
  // "pinterest.com", since "pinterest.com" contains "t.co"). When the URL
  // parses, the hostname is authoritative — lookalike hosts (notpinterest.com,
  // pinterest.com.evil.com) must NOT match.
  try {
    const host = new URL(url.trim()).hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "");
    // `host === d || host.endsWith("." + d)` — a bare endsWith("youtube.com")
    // also matches lookalikes such as "notyoutube.com" / "evilinstagram.com".
    const on = (domain: string): boolean => host === domain || host.endsWith("." + domain);
    if (host === "youtu.be" || on("youtube.com") || on("youtube-nocookie.com")) return "youtube";
    if (on("tiktok.com")) return "tiktok";
    if (isPinItHost(host) || isPinterestHost(host)) return "pinterest";
    if (host === "x.com" || on("twitter.com") || host === "t.co") return "twitter";
    if (on("instagram.com") || host === "instagr.am") return "instagram";
    return "unknown";
  } catch {}
  // Fallback for malformed URLs (no parseable hostname): substring scan
  // (pinterest before twitter — "pinterest.com" contains "t.co").
  const u = url.toLowerCase();
  if (u.includes("youtube.com") || u.includes("youtu.be") || u.includes("youtube-nocookie")) return "youtube";
  if (u.includes("tiktok.com") || u.includes("vm.tiktok") || u.includes("vt.tiktok")) return "tiktok";
  if (u.includes("pin.it") || u.includes("pinterest.")) return "pinterest";
  if (u.includes("twitter.com") || u.includes("x.com")) return "twitter";
  if (u.includes("instagram.com") || u.includes("instagr.am")) return "instagram";
  return "unknown";
}

export function extractUrls(text: string): string[] {
  const regex = /https?:\/\/[^\s]+/gi;
  const matches = text.match(regex) || [];
  // strip trailing punctuation ) ] , . ! ?
  return matches.map((m) => m.replace(/[)\].,!?]+$/, ""));
}

export function isSupportedUrl(url: string): boolean {
  return detectPlatform(url) !== "unknown";
}

export function platformEmoji(p: string | null): string {
  switch (p) {
    case "tiktok": return "🎵";
    case "youtube": return "▶️";
    case "twitter": return "🐦";
    case "instagram": return "📸";
    case "pinterest": return "📌";
    default: return "🎬";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
