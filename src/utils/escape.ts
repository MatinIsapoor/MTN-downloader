/**
 * Telegram parse-mode escaping helpers.
 *
 * Dynamic content (usernames, first names, URLs, file paths) routinely
 * contains characters that Telegram's parsers treat as markup: usernames may
 * contain "_", paths contain "\\" and "<", URLs contain "&". A single
 * unescaped character makes Telegram reject the whole message with
 * "can't parse entities", so the admin/user sees nothing at all.
 *
 * HTML mode is preferred over Markdown(V2) wherever dynamic text is mixed in:
 * only three characters need escaping and it supports <b>/<code>.
 */

/** Escape text for Telegram's HTML parse mode. */
export function escapeHtml(input: unknown): string {
  return String(input ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Escape text for Telegram's legacy "Markdown" parse mode. */
export function escapeMarkdown(input: unknown): string {
  return String(input ?? "").replace(/([_*`[])/g, "\\$1");
}

/** Escape text for Telegram's "MarkdownV2" parse mode (all reserved chars). */
export function escapeMarkdownV2(input: unknown): string {
  return String(input ?? "").replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}
