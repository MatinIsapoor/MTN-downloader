import { Telegraf, Context } from "telegraf";
import { config, isAdmin } from "./config";
import { initDatabase } from "./database";
import { userMiddleware } from "./bot/middlewares/auth";
import { registerUserHandlers } from "./bot/handlers/user";
import {
  registerAdminHandlers,
  isBroadcastWaiting,
  handleAdminText,
  isFindWaiting,
  setFindWaiting,
  handleFindText,
} from "./bot/handlers/admin";
import { cleanupOldFiles, logDownloaderDiagnostics, ensureCookiesFromEnv, maybeAutoUpdateYtDlp, enforceDiskBudget } from "./services/downloader";
import { handleHealthRequest } from "./services/keepalive";

async function main() {
  console.log("🚀 Starting Telegram Downloader Bot...");

  // Initialize database (async for sql.js)
  await initDatabase();
  console.log("✅ Database initialized");

  // Render's free plan has an EPHEMERAL filesystem and no persistent disks:
  // ./data/bot.db is wiped on every restart/redeploy, so users, stats and
  // history silently reset. Say so loudly instead of letting the admin wonder
  // why the user table is empty again.
  if (process.env.RENDER || process.env.RENDER_EXTERNAL_URL) {
    console.warn(
      `⚠️ Render detected: ${config.databasePath} is on an ephemeral disk — user stats/download history reset on every restart/redeploy. ` +
        "Render's free plan cannot attach a persistent disk; move the bot to a host with persistent storage (or a paid Render disk) if history must survive."
    );
  }

  // Downloader health: yt-dlp version, cookies, JS runtime, fallbacks
  // Restore cookies.txt from COOKIES_CONTENT first (Render-safe persistence).
  ensureCookiesFromEnv();
  // Best-effort nightly self-update when YTDLP_AUTO_UPDATE=true (heals stale
  // deploys without a manual redeploy), then log diagnostics.
  await maybeAutoUpdateYtDlp();
  logDownloaderDiagnostics();

  // Create bot
  const bot = new Telegraf<Context>(config.botToken);

  // Global middleware
  bot.use(userMiddleware);

  // Admin text interception MUST be registered before the user handlers:
  // Telegraf runs handlers in registration order, and the user handler would
  // otherwise consume an admin's search/broadcast text that happens to contain
  // a link (and start downloading it).
  //
  // Handle admin find-user trigger: intercept /find command
  bot.command("find", (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    setFindWaiting(ctx.from.id);
    ctx.reply("🔍 Send a username, name, or Telegram ID to search:");
  });

  // Handle admin broadcast trigger: intercept /broadcast command
  bot.command("broadcast", (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    // Import at top would be circular, so we access via action
    // This is handled by the admin_broadcast action, but we also allow the command
    ctx.reply("📢 Use the /admin panel and click *Broadcast* to send a message.", { parse_mode: "Markdown" });
  });

  // Intercept text messages for admin text input (broadcast, find)
  bot.on("text", async (ctx, next) => {
    const userId = ctx.from.id;
    const text = ctx.message.text;

    // Skip commands
    if (text.startsWith("/")) return next();

    // Check if admin is in find-user mode
    if (isAdmin(userId) && isFindWaiting(userId)) {
      const consumed = await handleFindText(ctx);
      if (consumed) return;
    }

    // Check if admin is in broadcast mode
    if (isAdmin(userId) && isBroadcastWaiting(userId)) {
      const consumed = await handleAdminText(ctx);
      if (consumed) return;
    }

    return next();
  });

  // Register handlers (after the admin interception above)
  registerUserHandlers(bot);
  registerAdminHandlers(bot);

  // Error handler
  bot.catch((err, ctx) => {
    console.error(`Error handling ${ctx.updateType}:`, err);
  });

  // Cleanup old downloads every hour
  setInterval(() => {
    cleanupOldFiles(2);
    enforceDiskBudget();
    console.log("🧹 Cleaned up old download files");
  }, 60 * 60 * 1000);

  // Remove leftovers from a previous run (crash/redeploy orphans) so the
  // disk doesn't fill up over time on hosts with small ephemeral disks.
  cleanupOldFiles(2);
  enforceDiskBudget();

  // Start bot with Webhook (for Render) or Polling (for local)
  const PORT = parseInt(process.env.PORT || '3000', 10);
  const isRender = !!process.env.RENDER_EXTERNAL_URL;

  if (isRender) {
    // در Render: از Webhook استفاده کن (public launch API; startWebhook is private)
    const domain = process.env.RENDER_EXTERNAL_URL as string;
    await bot.launch({
      webhook: {
        domain,
        path: "/webhook",
        port: PORT,
        // Telegraf calls this `cb` for any non-webhook request, so use it to
        // answer Render / UptimeRobot health checks on the same PORT.
        cb: (req, res) => {
          if (handleHealthRequest(req, res)) return;
          res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Not found");
        },
      },
    });
    console.log(`✅ Webhook تنظیم شد: ${domain}/webhook`);
    console.log(`🚀 ربات روی پورت ${PORT} در حال اجراست!`);
    console.log(`🏓 Health check: ${domain}/health`);

  } else {
    // در محیط محلی (کامپیوتر خودتان): از Polling استفاده کن
    await bot.launch();
    console.log("✅ Bot is running locally with polling!");
  }

  // Graceful stop
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
}

main().catch((err) => {
  console.error("❌ Failed to start bot:", err);
  process.exit(1);
});
