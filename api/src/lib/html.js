// html.js: putting data into HTML safely (from NURA). Every value that came from a guest (a name,
// a cancel reason) goes through esc() before it's placed in an email's HTML: a name like
// <img onerror=…> must arrive as text, never as markup.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
