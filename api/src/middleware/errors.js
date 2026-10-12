// errors.js: one consistent error shape for the whole API: { "error": "message" }.
//
// Route code throws httpError(404, 'Product not found'). Express 5 forwards errors thrown
// in async handlers here automatically. No try/catch in every route.

/** An error that is safe to show the user, with the HTTP status to send. */
export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true; // the message was written for the user, so it may be sent
  return err;
}

export function notFound(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// Express recognises an error handler by its four arguments, so `next` must stay even if unused.
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  // Malformed JSON bodies come from express.json() with status 400.
  const status = err.status ?? err.statusCode ?? 500;

  if (status >= 500) {
    // Full detail goes to the logs only (req.log comes from pino-http), tagged with the request ID.
    req.log?.error({ err }, 'unhandled error');
  }

  // Only messages we wrote for users are shown. An unexpected error's message can contain
  // SQL, file paths or secrets, so the browser only gets a generic line plus the request ID
  // needed to find the full error in the logs.
  const message = err.expose && status < 500 ? err.message : 'Something went wrong';
  // needsTotp tells the admin page to show the code box instead of an error.
  res.status(status).json({ error: message, requestId: req.id, ...(err.needsTotp ? { needsTotp: true } : {}) });
}
