// logger.js: structured JSON logs (pino).
//
// Nothing personal or secret should ever reach a log (see lib/logSafe.js for why and how):
//   redact      fields named like secrets or contact details, at the top level and one down
//   serializers errors lose query parameters and the values Postgres quotes back
import { pino } from 'pino';
import { config } from './config.js';
import { errSerializer } from './lib/logSafe.js';

// pino's redact paths are exact: '*.phone' means "a phone field one level down". Logged objects
// are shallow ({ err, bookingId, … }), so the top level and one level down cover them.
const FIELDS = ['password', 'token', 'secret', 'phone', 'email', 'to', 'name', 'firstName', 'lastName',
  'requests', 'message', 'apiKey', 'api_key', 'signature', 'body'];

export const LOG_OPTIONS = {
  redact: {
    paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]',
            ...FIELDS, ...FIELDS.map((f) => `*.${f}`)],
    censor: '[redacted]',
  },
  serializers: { err: errSerializer(pino.stdSerializers.err) },
};

/** A logger with the site's rules. `destination` lets tests read what would have been written. */
export function createLogger(level = config.LOG_LEVEL, destination) {
  return pino({ ...LOG_OPTIONS, level }, destination);
}

export const logger = createLogger(config.isTest ? 'silent' : config.LOG_LEVEL);
