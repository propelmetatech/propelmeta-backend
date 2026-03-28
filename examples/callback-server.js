const http = require('node:http');
const { URL } = require('node:url');
const querystring = require('node:querystring');
const path = require('node:path');
const loadEnv = require('../utils/loadEnv');

loadEnv(path.resolve(__dirname, '../.env'));

function base64urlToBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
}

function decodeJwtPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid x-gl-token format.');
  }

  const payloadJson = Buffer.from(base64urlToBase64(parts[1]), 'base64').toString('utf8');
  return JSON.parse(payloadJson);
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload, null, 2));
}

const port = Number(process.env.PORT || 3001);
const successRedirect = process.env.SUCCESS_REDIRECT_URL;
const failureRedirect = process.env.FAILURE_REDIRECT_URL;

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://localhost:${port}`);

  if (url.pathname !== '/callbackurl') {
    sendJson(response, 404, { message: 'Not found' });
    return;
  }

  let rawBody = '';
  request.on('data', (chunk) => {
    rawBody += chunk;
  });

  request.on('end', () => {
    try {
      const formBody = querystring.parse(rawBody);
      const xGlToken = formBody['x-gl-token'] || request.headers['x-gl-token'] || url.searchParams.get('x-gl-token');

      console.log('------ callbackurl request ------');
      console.log('headers:', request.headers);
      console.log('body:', formBody);

      if (!xGlToken) {
        console.error('Missing x-gl-token');
        if (failureRedirect) {
          response.writeHead(302, {
            Location: `${failureRedirect}?reason=Missing+payment+token`,
          });
          response.end();
          return;
        }

        sendJson(response, 400, { message: 'Missing x-gl-token' });
        return;
      }

      const decoded = decodeJwtPayload(Array.isArray(xGlToken) ? xGlToken[0] : xGlToken);
      console.log('\n========== decoded callback payload ==========' );
      console.log(decoded);
      console.log('=============================================\n');

      if (decoded.status === 'SENT_FOR_CAPTURE') {
        const queryParams = new URLSearchParams({
          txnId: decoded.merchantTxnId || 'N/A',
          amount: decoded.Amount || decoded.amount || 'N/A',
          status: decoded.status,
          gid: decoded.gid || decoded['x-gl-gid'] || 'N/A',
          paymentMethod: decoded.paymentMethod || 'CARD',
        });

        if (successRedirect) {
          response.writeHead(302, {
            Location: `${successRedirect}?${queryParams.toString()}`,
          });
          response.end();
          return;
        }

        sendJson(response, 200, { ok: true, payload: decoded, redirectQuery: queryParams.toString() });
        return;
      }

      const reason =
        decoded.failureReason || decoded.message || `Payment status: ${decoded.status}`;
      if (failureRedirect) {
        response.writeHead(302, {
          Location: `${failureRedirect}?reason=${encodeURIComponent(reason)}&txnId=${
            decoded.merchantTxnId || 'N/A'
          }`,
        });
        response.end();
        return;
      }

      sendJson(response, 200, { ok: false, payload: decoded, reason });
    } catch (error) {
      console.error('Callback error:', error.message);
      if (failureRedirect) {
        response.writeHead(302, {
          Location: `${failureRedirect}?reason=${encodeURIComponent(error.message)}`,
        });
        response.end();
        return;
      }

      sendJson(response, 500, { error: 'Server error', details: error.message });
    }
  });
});

server.listen(port, () => {
  console.log(`Callback test server listening on http://localhost:${port}/callbackurl`);
});
