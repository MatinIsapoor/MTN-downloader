/**
 * Shared download helpers: file-size handling + timeouts.
 *
 * No dependencies — imported by the YouTube HTTPS providers (piped,
 * invidious, youtubei) and the yt-dlp paths so "too large" behaves the
 * same everywhere: try a lower rendition first, fail with a clear message
 * only when nothing fits.
 */

/** Thrown when a rendition exceeds Telegram's file limit — catch and try lower. */
export class TooLargeError extends Error {
  constructor(message?: string) {
    super(message || "File too large");
    this.name = "TooLargeError";
  }
}

/** True when a message (ours or yt-dlp's) means "over the size limit". */
export function isTooLargeMessage(msg: any): boolean {
  if (msg instanceof TooLargeError) return true;
  if (typeof msg !== "string") return false;
  return (
    msg.includes("Video too large") ||
    msg.includes("File too large") ||
    msg.includes("max-filesize") ||
    msg.includes("File is larger than")
  );
}

/**
 * Quality ladder to try when a download exceeds the size limit.
 * Returns heights in descending order, starting at the configured cap
 * (0 = uncapped → start at 720p, since anything higher rarely fits 50MB).
 * Example: cap 720 → [720, 480, 360, 240]; cap 1080 → [1080, 720, 480, 360].
 */
export function qualityLadder(cap: number): number[] {
  const steps = [1080, 720, 480, 360, 240];
  const start = cap > 0 ? cap : 720;
  const ladder = steps.filter((h) => h <= start);
  // Always end at 240p so there is a last resort before giving up.
  if (!ladder.includes(240)) ladder.push(240);
  return ladder;
}

/** Heights below `failedHeight` on the ladder (for "retry lower" loops). */
export function lowerHeights(failedHeight: number): number[] {
  const steps = [1080, 720, 480, 360, 240];
  return steps.filter((h) => h < failedHeight);
}

/**
 * Race a promise against a timeout. On timeout the timer fires but the
 * underlying operation is NOT cancelled — callers that spawn processes
 * must kill them separately (see runYtDlpAttempt timeouts).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`❌ ${label} timed out after ${Math.round(ms / 1000)}s. Please try again.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!));
}
