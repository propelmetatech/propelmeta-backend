const fs = require('node:fs');
const path = require('node:path');
const { generateJWEAndJWS } = require('../index');
const loadEnv = require('../utils/loadEnv');

const DEFAULT_CALLBACK_URL = ' http://localhost:5173/callbackurl';

loadEnv(path.resolve(__dirname, '../.env'));

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function readPem(filePath) {
  return fs.readFileSync(path.resolve(filePath), 'utf8');
}

function createMerchantTxnId() {
  return `${Date.now()}${Math.floor(Math.random() * 1000000)}`;
}

function buildPayload() {
  return {
    merchantTxnId: process.env.PAYGLOCAL_MERCHANT_TXN_ID || createMerchantTxnId(),
    paymentData: {
      totalAmount: process.env.PAYGLOCAL_TOTAL_AMOUNT || '499.00',
      txnCurrency: process.env.PAYGLOCAL_TXN_CURRENCY || 'USD',
    },
    standingInstruction: {
      data: {
        amount: process.env.PAYGLOCAL_STANDING_AMOUNT || process.env.PAYGLOCAL_TOTAL_AMOUNT || '499.00',
        numberOfPayments: process.env.PAYGLOCAL_NUMBER_OF_PAYMENTS || '12',
        frequency: process.env.PAYGLOCAL_FREQUENCY || 'MONTHLY',
        type: process.env.PAYGLOCAL_STANDING_TYPE || 'FIXED',
        startDate: process.env.PAYGLOCAL_START_DATE || '20260401',
      },
    },
    merchantCallbackURL: process.env.PAYGLOCAL_CALLBACK_URL || DEFAULT_CALLBACK_URL,
  };
}

async function main() {
  const merchantId = requireEnv('PAYGLOCAL_MERCHANT_ID');
  const privateKeyId = requireEnv('PAYGLOCAL_PRIVATE_KEY_ID');
  const publicKeyId = requireEnv('PAYGLOCAL_PUBLIC_KEY_ID');
  const privateKeyPath = requireEnv('PAYGLOCAL_PRIVATE_KEY_PATH');
  const publicKeyPath = requireEnv('PAYGLOCAL_PUBLIC_KEY_PATH');
  const endpoint = process.env.PAYGLOCAL_INITIATE_URL || 'https://api.uat.payglocal.in/gl/v1/payments/initiate/paycollect';

  const payload = buildPayload();
  const publicKey = readPem(publicKeyPath);
  const privateKey = readPem(privateKeyPath);

  const { jweToken, jwsToken } = await generateJWEAndJWS({
    payload,
    publicKey,
    privateKey,
    merchantId,
    publicKeyId,
    privateKeyId,
  });

  console.log('Payload sent to PayGlocal:');
  console.log(JSON.stringify(payload, null, 2));
  console.log('jwetoken', jweToken);
  console.log('jwstoken', jwsToken);

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain',
      'x-gl-token-external': jwsToken,
    },
    body: jweToken,
  });

  const rawBody = await response.text();

  let parsedBody = rawBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = rawBody;
  }
  // console.log(payload,
  //   publicKey,
  //   privateKey,
  //   merchantId,
  //   publicKeyId,
  //   privateKeyId,)
  console.log('\nPayGlocal HTTP status:', response.status);
  console.log('PayGlocal response:');
  console.log(typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody, null, 2));

  if (!response.ok) {
    process.exitCode = 1;
    return;
  }

  const redirectUrl = parsedBody?.data?.redirectUrl;
  if (redirectUrl) {
    console.log('\nOpen this PayGlocal URL in the browser to continue payment:');
    console.log(redirectUrl);
  }

  const statusUrl = parsedBody?.data?.statusUrl;
  if (statusUrl) {
    console.log('\nStatus URL returned by PayGlocal:');
    console.log(statusUrl);
  }
}

main().catch((error) => {
  console.error('SI PayCollect initiate test failed:', error.message);
  process.exitCode = 1;
});
