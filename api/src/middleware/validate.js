// validate.js: check a request's query string or body against a Zod schema before any route
// code runs. Anything unexpected (a wrong type, an unknown field such as "price") is a 400
// with a readable message, and the route receives only the clean, typed values.
//
// Express 5 makes req.query read-only, so parsed values go on req.valid instead.
import { httpError } from './errors.js';

export const validate = (schema, source = 'body') => (req, res, next) => {
  const parsed = schema.safeParse(req[source] ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path.join('.');
    const unknown = issue.code === 'unrecognized_keys' ? `Unknown field: ${issue.keys.join(', ')}` : null;
    return next(httpError(400, unknown ?? (field ? `${field}: ${issue.message}` : issue.message)));
  }
  req.valid = { ...req.valid, [source]: parsed.data };
  next();
};
