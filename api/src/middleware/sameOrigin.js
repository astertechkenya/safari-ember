// sameOrigin.js: CSRF protection.
//
// Browsers attach an Origin header to every POST/PATCH/DELETE they send. If it names a site
// other than Safari Ember, the request was triggered by someone else's page and is refused.
// Requests with no Origin at all (curl, and payment providers' server-to-server callbacks)
// aren't browsers acting on a guest's behalf, so they pass here and are checked by their own route.
import { config } from '../config.js';
import { httpError } from './errors.js';

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const allowed = new Set([new URL(config.SITE_URL).origin]);
if (!config.isProd) allowed.add('http://localhost:8000').add('http://127.0.0.1:8000');

export function sameOrigin(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !allowed.has(origin)) return next(httpError(403, 'Cross-site request refused'));
  next();
}
