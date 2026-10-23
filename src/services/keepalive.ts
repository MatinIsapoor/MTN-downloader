import type { IncomingMessage, ServerResponse } from "http";

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 min (Render sleeps after ~15 min idle)
const MIN_INTERVAL_MS = 60 * 1000; // never ping more often than 1 min

/** Paths answered with 200 so Render / UptimeRobot / Telegram checks get traffic. */
export function isHealthPath(url?: string | null): boolean {
  if (!url) return false;
  // req.url is normally origin-form ("/health?x=1"), but absolute-form
  // ("http://host/health") is legal for proxy-style clients — those used to get
  // a 404. Drop the query/hash and normalize trailing slashes.
  let path = url.split("?")[0].split("#")[0];
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) {
    try { path = new URL(path).pathname; } catch { return false; }
  }
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === "/" || normalized === "/health" || normalized === "/healthz" || normalized === "/ping";
}

/**
 * Serve health checks on Telegraf's webhook HTTP server (passed as `cb` to
 * bot.launch). Returns true when the request was handled.
 */
export function handleHealthRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isHealthPath(req.url)) return false;
  // Health probes are fire-and-forget: a probe (including our own self-ping)
  // that disconnects before the response is written can surface an async socket
  // error on the response. Without a listener Node turns that into an uncaught
  // 'error' event and kills the bot.
  res.on("error", () => {});
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Give a monitor probing with the wrong verb a clear answer instead of
    // falling through to the generic 404 ("endpoint missing").
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      Allow: "GET, HEAD",
      "Content-Length": "0",
    });
    res.end();
    return true;
  }
  const body = `OK - uptime ${Math.floor(process.uptime())}s`;
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    // Explicit length: HEAD must advertise the same body size as GET, and a
    // fixed length avoids chunked framing for a 20-byte response on a
    // keep-alive socket.
    "Content-Length": String(Buffer.byteLength(body)),
  });
  if (req.method === "GET") res.end(body);
  else res.end();
  return true;
}

export interface KeepaliveConfig {
  enabled: boolean;
  publicUrl: string;
  intervalMs: number;
}

export function resolveKeepaliveConfig(): KeepaliveConfig {
  // Accept both "https://app.onrender.com" and a bare host name. fetch() throws
  // on a scheme-less URL, so a bare host made every ping fail forever while the
  // feature still looked enabled. Only http(s) URLs can be self-pinged.
  let publicUrl = (
    process.env.KEEPALIVE_URL ||
    process.env.RENDER_EXTERNAL_URL ||
    ""
  ).trim().replace(/\/+$/, "");
  if (publicUrl && !/^[a-z][a-z0-9+.-]*:\/\//i.test(publicUrl)) publicUrl = `https://${publicUrl}`;
  let publicUrlValid = false;
  if (publicUrl) {
    try {
      const parsed = new URL(publicUrl);
      publicUrlValid = parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {}
  }
  const rawInterval =
    process.env.KEEPALIVE_INTERVAL_MS ||
    (process.env.KEEPALIVE_INTERVAL_MINUTES
      ? String(Number(process.env.KEEPALIVE_INTERVAL_MINUTES) * 60 * 1000)
      : "");
  let intervalMs = Number(rawInterval) || DEFAULT_INTERVAL_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < MIN_INTERVAL_MS) {
    intervalMs = MIN_INTERVAL_MS;
  }
  const explicitlyDisabled = (process.env.KEEPALIVE_ENABLED || "").toLowerCase() === "false";
  return { enabled: !explicitlyDisabled && publicUrlValid, publicUrl, intervalMs };
}

/**
 * Ping our own public /health URL on an interval. Each ping is inbound HTTP
 * traffic, which resets Render's ~15 min idle spin-down timer while we are awake.
 * NOTE: this cannot wake an already-sleeping service — pair it with a free
 * external pinger (UptimeRobot / cron-job.org every 5 min -> /health).
 */
export function startSelfPing(publicUrl: string, intervalMs: number = DEFAULT_INTERVAL_MS) {
  const target = `${publicUrl.replace(/\/+$/, "")}/health`;
  console.log(`⏰ Keep-alive self-ping enabled: GET ${target} every ${Math.round(intervalMs / 60000)} min`);

  // A fire-and-forget ping must never stay pending forever: without an abort a
  // single wedged connection left the fetch (and its socket) open, and the
  // interval then stacked MORE overlapping pings on top of it.
  const pingTimeoutMs = Math.min(30000, Math.max(5000, intervalMs - 1000));
  let inFlight = false;
  const ping = async () => {
    // Skip (rather than queue) a tick while the previous ping is still running.
    if (inFlight) return;
    inFlight = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), pingTimeoutMs);
    try {
      const res = await fetch(target, {
        headers: { "Cache-Control": "no-store" },
        signal: controller.signal,
      });
      // Drain the (tiny) body: an unconsumed response body keeps its connection
      // checked out in the agent's pool, leaking a socket per ping.
      try { await res.arrayBuffer(); } catch {}
      console.log(`⏰ Keep-alive ping: ${res.status} ${target}`);
    } catch (err) {
      console.warn(`⏰ Keep-alive ping failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  };

  // Small initial delay so webhook registration finishes first, then interval.
  const initialDelay = Math.min(30 * 1000, intervalMs);
  const initialTimer = setTimeout(() => {
    void ping();
  }, initialDelay);
  if (typeof initialTimer === "object" && "unref" in initialTimer) {
    (initialTimer as NodeJS.Timeout).unref?.();
  }

  const timer = setInterval(() => {
    void ping();
  }, intervalMs);
  if (typeof timer === "object" && "unref" in timer) {
    (timer as NodeJS.Timeout).unref?.();
  }
  return timer;
}
