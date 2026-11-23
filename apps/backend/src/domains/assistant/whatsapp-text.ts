/**
 * Rewrites the Markdown a model writes by habit into WhatsApp's own markup,
 * which bolds `*x*`, italicises `_x_` and strikes `~x~`, and shows `**x**`,
 * `# x` and `[x](url)` as typed. The prompt asks for WhatsApp markup, but
 * models still slip.
 */
export function toWhatsAppText(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/__(.+?)__/g, "_$1_")
    .replace(/~~(.+?)~~/g, "~$1~")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)");
}
