// A stand-in for Safaricom's Daraja API, for tests. It answers the three calls Safari Ember makes
// (token, STK push, STK query) and records what it was sent.
//
//   fake.outcome.set(checkoutRequestId, { state: 'paid' } | { state: 'failed', code: '1032' } | { state: 'pending' }
//                    | { state: 'unclear', code: '4999' })   a ResultCode that isn't a final answer
//   fake.failNextPush = true   → the next push is refused (Safaricom down)
import http from 'node:http';

export function startFakeDaraja(port = 4599) {
  const fake = { pushes: [], queries: [], outcome: new Map(), failNextPush: false, n: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url.startsWith('/oauth/v1/generate')) {
        if (req.headers.authorization !== `Basic ${Buffer.from('test-key:test-secret').toString('base64')}`) return send(400, {});
        return send(200, { access_token: 'fake-token', expires_in: '3599' });
      }
      if (req.headers.authorization !== 'Bearer fake-token') return send(401, { errorCode: '404.001.03', errorMessage: 'Invalid Access Token' });
      const body = JSON.parse(raw || '{}');
      if (req.url === '/mpesa/stkpush/v1/processrequest') {
        fake.pushes.push(body);
        if (fake.failNextPush) { fake.failNextPush = false; return send(500, { errorCode: '500.001.1001', errorMessage: 'Service unavailable' }); }
        const id = `ws_CO_TEST_${++fake.n}_${Date.now()}`;
        fake.outcome.set(id, { state: 'pending' });
        return send(200, { MerchantRequestID: `m-${fake.n}`, CheckoutRequestID: id, ResponseCode: '0', ResponseDescription: 'Success. Request accepted for processing', CustomerMessage: 'Success.' });
      }
      if (req.url === '/mpesa/stkpushquery/v1/query') {
        fake.queries.push(body);
        const o = fake.outcome.get(body.CheckoutRequestID);
        if (!o || o.state === 'pending') return send(500, { errorCode: '500.001.1001', errorMessage: 'The transaction is being processed' });
        if (o.state === 'paid') return send(200, { ResponseCode: '0', ResultCode: '0', ResultDesc: 'The service request is processed successfully.' });
        if (o.state === 'unclear') return send(200, { ResponseCode: '0', ResultCode: o.code, ResultDesc: 'The transaction is still under processing' });
        return send(200, { ResponseCode: '0', ResultCode: o.code, ResultDesc: 'Request cancelled by user' });
      }
      send(404, {});
    });
  });
  // A port already in use fails the tests at once, instead of hanging until a timeout.
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok({ fake, close: () => new Promise((r) => server.close(r)) }));
  });
}

/** The body Safaricom posts to the callback URL. */
export function callbackBody(checkoutRequestId, { code = 0, amount = 1, receipt = 'QK12TEST34', phone = 254712345678 } = {}) {
  const stkCallback = {
    MerchantRequestID: 'm-1', CheckoutRequestID: checkoutRequestId, ResultCode: code,
    ResultDesc: code === 0 ? 'The service request is processed successfully.' : 'Request cancelled by user',
  };
  if (code === 0) {
    stkCallback.CallbackMetadata = { Item: [
      { Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: receipt },
      { Name: 'TransactionDate', Value: 20260929143005 }, { Name: 'PhoneNumber', Value: phone },
    ] };
  }
  return { Body: { stkCallback } };
}
