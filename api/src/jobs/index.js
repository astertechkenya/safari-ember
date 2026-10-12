// jobs/index.js: work the API does on a timer, not in answer to a request.
//
// One job for now: holds whose time ran out become EXPIRED. (Availability already ignores a
// lapsed hold the second it lapses, so this is tidying, not correctness: the admin's list
// shows EXPIRED, and from Phase 4 the guest gets a "your hold ran out" email.)
//
// The job only has work while a hold is open. When there's none it goes quiet: no timer, no
// database queries. On Neon's free plan the database sleeps after 5 idle minutes, and the
// monthly allowance is smaller than a month of being awake, so a query every minute forever
// would use it up. A new hold wakes the job (wakeJobs, from routes/bookings.js); it then runs
// every minute until no hold is open. Same design as NURA's payment jobs.
import { logger } from '../logger.js';
import { expireHolds, anyOpenHolds } from '../services/bookings.js';

const EVERY_MINUTE = 60 * 1000;
let timer = null;
let running = false;
let started = false;
let wakeCount = 0;              // bumped by every wake; a tick only goes quiet if none came in meanwhile

async function tick() {
  if (running) return;          // a slow run is never overlapped by the next one
  running = true;
  const wakesAtStart = wakeCount;
  try {
    const n = await expireHolds();
    if (n) logger.info({ expired: n }, 'expired unpaid holds');
    // Nothing left to watch: stop until woken. Unless a wake arrived while this tick ran (a
    // hold committed just after the check): then stopping would leave it unwatched.
    if (!(await anyOpenHolds()) && wakeCount === wakesAtStart) quiet();
  } catch (err) {
    logger.error({ err }, 'hold expiry job failed');   // logged, retried next minute
  } finally {
    running = false;
  }
}

function every() {
  if (timer) return;
  timer = setInterval(tick, EVERY_MINUTE);
  timer.unref();                // never keeps the process alive on its own
}
function quiet() { clearInterval(timer); timer = null; }

export function startJobs() {
  if (started) return;
  started = true;
  every();
  tick();                       // catch up on anything left open before a restart
}

/** A hold was just created: run every minute until none is open. */
export function wakeJobs() {
  if (!started) return;         // tests and scripts never start the timer
  wakeCount += 1;
  every();
}

export function stopJobs() {
  started = false;
  quiet();
}

export { tick as runJobsOnce };
