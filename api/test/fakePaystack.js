// A stand-in for Paystack's API, for tests: initialize, verify, and signed webhooks.
//
//   fake.result.set(reference, { status: 'success', amount: 240000, currency: 'KES', last4: '4081' })
//   fake.failNextInit = true   → the next initialize is refused (Paystack down)
import http from 'node:http';
import { createHmac } from 'node:crypto';

export const TEST_KEY = 'sk_test_fakeKeyForTestsOnly0123456789';

export function startFakePaystack(port = 4597) {
  const fake = { inits: [], result: new Map(), failNextInit: false };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return send(401, { status: false, message: 'Invalid key' });
      if (req.method === 'POST' && req.url === '/transaction/initialize') {
        const body = JSON.parse(raw || '{}');
        fake.inits.push(body);
        if (fake.failNextInit) { fake.failNextInit = false; return send(503, { status: false, message: 'Service unavailable' }); }
        return send(200, { status: true, message: 'Authorization URL created',
          data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, access_code: 'ac', reference: body.reference } });
      }
      const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
      if (req.method === 'GET' && m) {
        const ref = decodeURIComponent(m[1]);
        const init = fake.inits.find((i) => i.reference === ref);
        if (!init) return send(400, { status: false, message: 'Transaction reference not found' });
        const r = fake.result.get(ref) ?? { status: 'abandoned' };
        return send(200, { status: true, message: 'Verification successful', data: {
          id: 4099, status: r.status, reference: ref, amount: r.amount ?? init.amount, currency: r.currency ?? 'KES',
          channel: 'card', gateway_response: r.message ?? (r.status === 'success' ? 'Approved' : 'Declined'),
          authorization: { last4: r.last4 ?? '4081' },
        } });
      }
      send(404, { status: false, message: 'Not found' });
    });
  });
  // A port already in use fails the tests at once, instead of hanging until a timeout.
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok({ fake, close: () => new Promise((r) => server.close(r)) }));
  });
}

/** A webhook body and its signature, exactly as Paystack would send them. */
export function signedEvent(event, key = TEST_KEY) {
  const raw = JSON.stringify(event);
  return { raw, signature: createHmac('sha512', key).update(raw).digest('hex') };
}
