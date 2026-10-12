// logSafe.js: what may reach a log line.
//
// Render keeps logs, and anyone who can read them sees what's in them. Kenya's Data Protection
// Act asks us to collect only the personal data we need, and logs need none: to trace a problem
// we need what happened, not who it happened to. Three leaks are closed here:
//
//   1. Query strings. The admin will search by name, email or phone (?q=…), so a plain request
//      log would write those down. Only values of known-harmless keys (page, status…) are kept.
//   2. Database errors. Drizzle's errors carry the query's PARAMETERS (an email, a phone, an
//      address, a password hash) in `params` and in the message itself; Postgres puts the
//      offending value in `detail` ("Key (email)=(jane@x.com) already exists") and, for bad
//      input, in the message. Those are removed; the SQL and the error code stay, which is
//      what debugging needs.
//   3. Fields named like secrets or contact details, anywhere in a logged object (logger.js).

// Query keys whose values are never personal: filters, paging, sorting.
// Stay dates and guest counts aren't personal on their own, and they're what debugging a
// "why no rooms?" report needs.
const SAFE_QUERY_KEYS = new Set(['page', 'status', 'sort', 'limit', 'checkIn', 'checkOut', 'guests', 'from', 'to']);

/** /api/admin/customers?q=jane@x.com&page=2 → /api/admin/customers?q=[redacted]&page=2 */
export function safeUrl(url) {
  const raw = String(url ?? '')
    // The M-Pesa callback address contains a secret.
    .replace(/(\/callback\/)[^/?]+/, '$1[redacted]');
  const q = raw.indexOf('?');
  if (q < 0) return raw;
  const query = raw.slice(q + 1).split('&').filter(Boolean).map((pair) => {
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    if (eq < 0) return key;
    let name;
    try { name = decodeURIComponent(key); } catch { name = key; }
    return SAFE_QUERY_KEYS.has(name) ? pair : `${key}=[redacted]`;
  });
  return `${raw.slice(0, q)}?${query.join('&')}`;
}

/** The request as it appears in each log line. */
export const reqSerializer = (verify) => (req) => ({
  id: req.id, method: req.method, url: safeUrl(req.url),
  // true when the request came through our signed Netlify proxy. If site requests ever
  // log false in production, the NETLIFY_PROXY_SECRET values on Netlify and Render differ.
  viaNetlify: Boolean(verify(req.headers['x-nf-sign'])),
});

// Postgres' SQLSTATE class 22 ("data exception") messages quote the bad value:
//   invalid input syntax for type integer: "0712345678"
const quotedValue = /"(?:[^"\\]|\\.)*"/g;
const isPgError = (e) => e && typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code) && 'severity' in e;
const isDrizzleError = (e) => e && typeof e.query === 'string' && Array.isArray(e.params);

// Only the "at …" lines of a stack: the first line repeats the message (values and all), and
// Drizzle adds a "params:" line and the cause's own stack (serialised separately, scrubbed).
const frames = (stack) => String(stack ?? '').split('\n').slice(1).filter((l) => /^\s+at /.test(l)).join('\n');

function scrubDb(err, depth) {
  if (isDrizzleError(err)) {
    // The query's text is kept (it has $1, $2… placeholders, never values); the params go.
    return { type: err.constructor?.name ?? 'DrizzleQueryError', message: `Failed query: ${err.query}`, query: err.query,
             stack: frames(err.stack), cause: err.cause ? safeError(err.cause, depth + 1) : undefined };
  }
  const dataException = err.code.startsWith('22');
  return {
    type: 'DatabaseError', code: err.code,
    message: dataException ? String(err.message).replace(quotedValue, '"[redacted]"') : err.message,
    // "Key (email)=(jane@x.com) already exists." → "Key (email)=([redacted]) already exists."
    // "Failing row contains (…the whole row…)." → "Failing row contains ([redacted])."
    detail: typeof err.detail === 'string'
      ? err.detail.replace(/=\((.*?)\)(?=[ .]|$)/g, '=([redacted])').replace(/(Failing row contains )\(.*\)/s, '$1([redacted])')
      : undefined,
    constraint: err.constraint, table: err.table, column: err.column,
    stack: frames(err.stack),
  };
}

/** An error as it may appear in a log: everything useful for debugging, no data from the request. */
export function safeError(err, depth = 0, std) {
  if (!err || typeof err !== 'object' || depth > 4) return err;
  if (isDrizzleError(err) || isPgError(err)) return scrubDb(err, depth);
  const out = std ? std(err) : { type: err.constructor?.name, message: err.message, stack: err.stack };
  // pino's serializer folds causes into message and stack; when the cause is a database error
  // that would bring its values back, so serialise the cause separately instead.
  if (err.cause && (isDrizzleError(err.cause) || isPgError(err.cause))) {
    out.message = err.message;
    out.stack = err.stack;
    out.cause = safeError(err.cause, depth + 1);
  }
  return out;
}

/** pino's err serializer, with database errors replaced by their scrubbed form. */
export const errSerializer = (std) => (err) => safeError(err, 0, std);
