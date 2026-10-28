// mask.js: what the read-only demo admin sees instead of a guest's personal details.
// Enough to tell bookings apart ("Amani W.", "a•••@example.com"), not enough to contact anyone.
// The masking happens on the server: the real values never reach a demo admin's browser.
export const maskName = (s) => (s ? `${s.trim()[0].toUpperCase()}.` : s);

export function maskEmail(s) {
  if (!s || !s.includes('@')) return s ? '•••' : s;
  const [user, domain] = s.split('@');
  return `${user[0]}•••@${domain}`;
}

/** +254710100100 → +254 7•• ••• 100 (the last three digits help match a phone call, nothing more) */
export function maskPhone(s) {
  if (!s) return s;
  const d = s.replace(/\s/g, '');
  return d.length < 8 ? '•••' : `${d.slice(0, 4)} ${d[4]}•• ••• ${d.slice(-3)}`;
}
