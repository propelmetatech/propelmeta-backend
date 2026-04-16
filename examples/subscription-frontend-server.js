const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const querystring = require('node:querystring');
const { URL } = require('node:url');
const { compactVerify, importSPKI } = require('jose');
const { generateJWEAndJWS } = require('../index');
const loadEnv = require('../utils/loadEnv');
const { TransactionStore } = require('../utils/transactionStore');

loadEnv(path.resolve(__dirname, '../.env'));

const DEFAULT_INITIATE_URL =
  'https://api.uat.payglocal.in/gl/v1/payments/initiate/paycollect';
const SUCCESS_STATUSES = new Set([
  'AUTHORIZED',
  'CAPTURED',
  'SENT_FOR_CAPTURE',
  'SUCCESS',
]);
const VALID_TIERS = new Set(['standard', 'premium', 'elite']);
const VALID_BILLING_CYCLES = new Set(['monthly', 'yearly']);
const PLAN_CATALOG = {
  standard: {
    tier: 'standard',
    title: 'Standard',
    summary: 'Social Media & Review Management',
    monthlyAmount: '179.00',
    yearlyAmount: '1999.00',
    yearlyMonthlyDisplay: '166.58',
  },
  premium: {
    tier: 'premium',
    title: 'Premium',
    summary: 'Everything in Standard + Website and Order Management',
    monthlyAmount: '299.00',
    yearlyAmount: '3499.00',
    yearlyMonthlyDisplay: '291.58',
    featured: true,
  },
  elite: {
    tier: 'elite',
    title: 'Elite',
    summary: 'Everything in Premium + Advertising, SEO and Menu Management',
    monthlyAmount: '499.00',
    yearlyAmount: '5499.00',
    yearlyMonthlyDisplay: '458.25',
  },
};

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

function normalizePem(value) {
  return String(value || '').replace(/\\n/g, '\n').trim();
}

function parsePositiveInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallbackValue;
  }

  return parsed;
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined || value === null || value === '') {
    return fallbackValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return fallbackValue;
}

function formatDateYYYYMMDD(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function getDefaultStartDate(startDayOfMonth = 4) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const targetDay = Math.max(1, Math.min(28, Number(startDayOfMonth) || 4));
  const currentMonthDate = new Date(Date.UTC(year, monthIndex, targetDay));
  const startDate =
    now <= currentMonthDate
      ? currentMonthDate
      : new Date(Date.UTC(year, monthIndex + 1, targetDay));
  return formatDateYYYYMMDD(startDate);
}

function parseAllowedOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function normalizeOrigin(origin) {
  return String(origin || '').trim().replace(/\/$/, '');
}

function isLocalHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1' ||
    hostname.endsWith('.local')
  );
}

function validateAbsoluteUrl(name, value, options = {}) {
  let parsedUrl;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }

  if (options.expectedPathname && parsedUrl.pathname !== options.expectedPathname) {
    throw new Error(`${name} must use path ${options.expectedPathname}.`);
  }

  if (options.productionStrict && process.env.NODE_ENV === 'production') {
    if (parsedUrl.protocol !== 'https:') {
      throw new Error(`${name} must use https in production.`);
    }

    if (isLocalHost(parsedUrl.hostname)) {
      throw new Error(`${name} cannot point to localhost in production.`);
    }
  }
}

function createMerchantTxnId() {
  return `${Date.now()}${crypto.randomBytes(6).toString('hex')}`;
}

function normalizeAmount(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`Invalid amount: ${value}`);
  }

  return numeric.toFixed(2);
}

function safeJsonParse(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseRequestBody(rawBody, contentType) {
  if (!rawBody) {
    return {};
  }

  if (contentType.includes('application/json')) {
    const parsedJson = safeJsonParse(rawBody);
    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new Error('Request body must be valid JSON.');
    }

    return parsedJson;
  }

  if (contentType.includes('application/x-www-form-urlencoded')) {
    return querystring.parse(rawBody);
  }

  const parsedJson = safeJsonParse(rawBody);
  if (parsedJson && typeof parsedJson === 'object' && !Array.isArray(parsedJson)) {
    return parsedJson;
  }

  return querystring.parse(rawBody);
}

function readRequestBody(request, maxBodySizeBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalLength = 0;
    let settled = false;

    request.on('data', (chunk) => {
      if (settled) {
        return;
      }

      totalLength += chunk.length;
      if (totalLength > maxBodySizeBytes) {
        settled = true;
        reject(new Error(`Request body exceeded ${maxBodySizeBytes} bytes.`));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    request.on('error', (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });

    request.on('aborted', () => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error('Request aborted before completion.'));
    });
  });
}

function getAllowedCorsOrigin(requestOrigin, allowedOrigins) {
  const normalizedOrigin = normalizeOrigin(requestOrigin);
  if (!normalizedOrigin) {
    return null;
  }

  if (allowedOrigins.includes('*')) {
    return normalizedOrigin;
  }

  const hasConfiguredMatch = allowedOrigins.some(
    (origin) => normalizeOrigin(origin) === normalizedOrigin,
  );
  if (hasConfiguredMatch) {
    return normalizedOrigin;
  }

  try {
    const parsedOrigin = new URL(normalizedOrigin);
    const isLoopbackRequest =
      ['http:', 'https:'].includes(parsedOrigin.protocol) &&
      isLocalHost(parsedOrigin.hostname);

    if (process.env.NODE_ENV !== 'production' && isLoopbackRequest) {
      return normalizedOrigin;
    }
  } catch {
    return null;
  }

  return null;
}

function setCorsHeaders(response, corsOrigin) {
  if (!corsOrigin) {
    return;
  }

  response.setHeader('Access-Control-Allow-Origin', corsOrigin);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  response.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Requested-With',
  );
  response.setHeader('Access-Control-Allow-Credentials', 'true');
  response.setHeader('Vary', 'Origin');
}

function sendJson(response, statusCode, payload, corsOrigin) {
  setCorsHeaders(response, corsOrigin);
  response.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(payload, null, 2));
}

function redirectTo(response, location) {
  response.writeHead(302, {
    Location: location,
    'Cache-Control': 'no-store',
  });
  response.end();
}

function buildRedirectUrl(baseUrl, searchParams) {
  const redirectUrl = new URL(baseUrl);

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    redirectUrl.searchParams.set(key, String(value));
  }

  return redirectUrl.toString();
}

function base64urlToBase64(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
}

function decodeJwtPayloadWithoutVerification(token) {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Invalid x-gl-token format.');
  }

  const payloadJson = Buffer.from(base64urlToBase64(parts[1]), 'base64').toString(
    'utf8',
  );
  return JSON.parse(payloadJson);
}

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: parsePositiveInteger(process.env.PORT, 3002),
  requestTimeoutMs: parsePositiveInteger(process.env.REQUEST_TIMEOUT_MS, 30000),
  headersTimeoutMs: parsePositiveInteger(process.env.HEADERS_TIMEOUT_MS, 35000),
  maxBodySizeBytes: parsePositiveInteger(process.env.MAX_BODY_SIZE_BYTES, 1048576),
  initiateUrl: process.env.PAYGLOCAL_INITIATE_URL || DEFAULT_INITIATE_URL,
  merchantId: requireEnv('PAYGLOCAL_MERCHANT_ID'),
  privateKeyId: requireEnv('PAYGLOCAL_PRIVATE_KEY_ID'),
  publicKeyId: requireEnv('PAYGLOCAL_PUBLIC_KEY_ID'),
  privateKey: requireEnv('PAYGLOCAL_PRIVATE_KEY'),
  publicKey: requireEnv('PAYGLOCAL_PUBLIC_KEY'),
  callbackUrl: requireEnv('PAYGLOCAL_CALLBACK_URL'),
  successRedirectUrl: requireEnv('SUCCESS_REDIRECT_URL'),
  failureRedirectUrl: requireEnv('FAILURE_REDIRECT_URL'),
  txnCurrency: (process.env.PAYGLOCAL_TXN_CURRENCY || 'USD').trim().toUpperCase(),
  standingType: process.env.PAYGLOCAL_STANDING_TYPE || 'FIXED',
  monthlyFrequency:
    process.env.PAYGLOCAL_MONTHLY_FREQUENCY ||
    process.env.PAYGLOCAL_FREQUENCY ||
    'MONTHLY',
  yearlyFrequency: process.env.PAYGLOCAL_YEARLY_FREQUENCY || 'YEARLY',
  monthlyNumberOfPayments:
    process.env.PAYGLOCAL_MONTHLY_NUMBER_OF_PAYMENTS ||
    process.env.PAYGLOCAL_NUMBER_OF_PAYMENTS ||
    '12',
  yearlyNumberOfPayments: process.env.PAYGLOCAL_YEARLY_NUMBER_OF_PAYMENTS || '1',
  monthlyStartDate:
    process.env.PAYGLOCAL_MONTHLY_START_DATE ||
    process.env.PAYGLOCAL_START_DATE ||
    getDefaultStartDate(process.env.PAYGLOCAL_START_DAY),
  yearlyStartDate:
    process.env.PAYGLOCAL_YEARLY_START_DATE ||
    process.env.PAYGLOCAL_START_DATE ||
    getDefaultStartDate(process.env.PAYGLOCAL_START_DAY),
  verifyCallbackSignature: parseBoolean(
    process.env.VERIFY_CALLBACK_SIGNATURE,
    true,
  ),
  storeTransactions: parseBoolean(process.env.STORE_TRANSACTIONS, true),
  allowedOrigins: parseAllowedOrigins(process.env.ALLOWED_ORIGIN),
  transactionStorePath:
    process.env.TRANSACTION_STORE_PATH ||
    path.resolve(__dirname, '../data/subscriptions.json'),
};

function validateConfig() {
  const errors = [];

  // if (!fs.existsSync(path.resolve(config.privateKeyPath))) {
  //   errors.push(`PAYGLOCAL_PRIVATE_KEY does not exist: ${config.privateKeyPath}`);
  // }

  // if (!fs.existsSync(path.resolve(config.publicKeyPath))) {
  //   errors.push(`PAYGLOCAL_PUBLIC_KEY does not exist: ${config.publicKeyPath}`);
  // }

  if (!/^\d{8}$/.test(config.monthlyStartDate)) {
    errors.push('PAYGLOCAL_MONTHLY_START_DATE must be in YYYYMMDD format.');
  }

  if (!/^\d{8}$/.test(config.yearlyStartDate)) {
    errors.push('PAYGLOCAL_YEARLY_START_DATE must be in YYYYMMDD format.');
  }

  try {
    validateAbsoluteUrl('PAYGLOCAL_CALLBACK_URL', config.callbackUrl, {
      expectedPathname: '/callbackurl',
      productionStrict: true,
    });
  } catch (error) {
    errors.push(error.message);
  }

  try {
    validateAbsoluteUrl('SUCCESS_REDIRECT_URL', config.successRedirectUrl, {
      productionStrict: true,
    });
  } catch (error) {
    errors.push(error.message);
  }

  try {
    validateAbsoluteUrl('FAILURE_REDIRECT_URL', config.failureRedirectUrl, {
      productionStrict: true,
    });
  } catch (error) {
    errors.push(error.message);
  }

  if (config.allowedOrigins.length === 0) {
    errors.push('ALLOWED_ORIGIN must contain at least one frontend origin.');
  }

  for (const origin of config.allowedOrigins) {
    try {
      validateAbsoluteUrl(`ALLOWED_ORIGIN entry (${origin})`, origin, {
        productionStrict: true,
      });
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Configuration error:\n- ${errors.join('\n- ')}`);
  }
}

validateConfig();

// const privateKey = readPem(config.privateKeyPath);
// const publicKey = readPem(config.publicKeyPath);
const privateKey = normalizePem(config.privateKey);
const publicKey = normalizePem(config.publicKey);
const transactionStore = config.storeTransactions
  ? new TransactionStore(config.transactionStorePath)
  : null;
let payglocalVerificationKeyPromise = null;

function getVerificationKey() {
  if (!payglocalVerificationKeyPromise) {
    payglocalVerificationKeyPromise = importSPKI(publicKey, 'RS256');
  }

  return payglocalVerificationKeyPromise;
}

async function decodeCallbackToken(token) {
  if (!config.verifyCallbackSignature) {
    return {
      payload: decodeJwtPayloadWithoutVerification(token),
      verified: false,
    };
  }

  const verificationKey = await getVerificationKey();
  const { payload } = await compactVerify(token, verificationKey);

  return {
    payload: JSON.parse(Buffer.from(payload).toString('utf8')),
    verified: true,
  };
}

function buildPlansResponse() {
  return {
    ok: true,
    currency: config.txnCurrency,
    plans: Object.values(PLAN_CATALOG).map((plan) => ({
      tier: plan.tier,
      title: plan.title,
      summary: plan.summary,
      featured: Boolean(plan.featured),
      pricing: {
        monthly: {
          chargeAmount: plan.monthlyAmount,
          displayMonthlyAmount: plan.monthlyAmount.replace(/\.00$/, ''),
        },
        yearly: {
          chargeAmount: plan.yearlyAmount,
          displayMonthlyAmount: plan.yearlyMonthlyDisplay,
          billedAnnuallyAmount: plan.yearlyAmount.replace(/\.00$/, ''),
        },
      },
    })),
  };
}

function buildSubscriptionPayload(merchantTxnId, billingCycle, chargeAmount) {
  const standingFrequency =
    billingCycle === 'monthly' ? config.monthlyFrequency : config.yearlyFrequency;
  const numberOfPayments =
    billingCycle === 'monthly'
      ? config.monthlyNumberOfPayments
      : config.yearlyNumberOfPayments;
  const startDate =
    billingCycle === 'monthly' ? config.monthlyStartDate : config.yearlyStartDate;

  return {
    merchantTxnId,
    paymentData: {
      totalAmount: chargeAmount,
      txnCurrency: config.txnCurrency,
    },
    standingInstruction: {
      data: {
        amount: chargeAmount,
        numberOfPayments,
        frequency: standingFrequency,
        type: config.standingType,
        startDate,
      },
    },
    merchantCallbackURL: config.callbackUrl,
  };
}

function extractXGlToken(parsedBody, request, url) {
  const bodyToken =
    parsedBody?.['x-gl-token'] ||
    parsedBody?.xGlToken ||
    parsedBody?.token ||
    null;
  const headerToken = request.headers['x-gl-token'] || null;
  const queryToken = url.searchParams.get('x-gl-token');
  const candidate = bodyToken || headerToken || queryToken;

  if (!candidate) {
    return null;
  }

  return Array.isArray(candidate) ? String(candidate[0]).trim() : String(candidate).trim();
}

async function initiateSubscription(body) {
  const tier = String(body?.tier || '').trim().toLowerCase();
  const billingCycle = String(body?.billingCycle || '').trim().toLowerCase();
  const customerId = body?.customerId ? String(body.customerId).trim() : undefined;

  if (!VALID_TIERS.has(tier)) {
    throw new Error('tier must be one of: standard, premium, elite.');
  }

  if (!VALID_BILLING_CYCLES.has(billingCycle)) {
    throw new Error('billingCycle must be one of: monthly, yearly.');
  }

  const plan = PLAN_CATALOG[tier];
  const chargeAmount = normalizeAmount(
    billingCycle === 'monthly' ? plan.monthlyAmount : plan.yearlyAmount,
  );
  const merchantTxnId = createMerchantTxnId();
  const now = new Date().toISOString();
  const payload = buildSubscriptionPayload(merchantTxnId, billingCycle, chargeAmount);

  if (transactionStore) {
    transactionStore.upsert({
      merchantTxnId,
      customerId,
      tier,
      billingCycle,
      chargeAmount,
      txnCurrency: config.txnCurrency,
      status: 'INITIATE_REQUESTED',
      callbackUrl: config.callbackUrl,
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    const { jweToken, jwsToken } = await generateJWEAndJWS({
      payload,
      publicKey,
      privateKey,
      merchantId: config.merchantId,
      publicKeyId: config.publicKeyId,
      privateKeyId: config.privateKeyId,
    });

    console.log(
      payload,
      publicKey,
      privateKey,
      config.merchantId,
      config.publicKeyId,
      config.privateKeyId,
      jweToken,
      jwsToken

    )

    console.log('Initiating subscription:', {
      merchantTxnId,
      tier,
      billingCycle,
      amount: chargeAmount,
      txnCurrency: config.txnCurrency,
    });        

    const response = await fetch(config.initiateUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-gl-token-external': jwsToken,
      },
      body: jweToken,
    });

    console.log(response)
console.log("Response Status:", response.status);
 
const rawBuffer = await response.arrayBuffer();

const rawText = Buffer.from(rawBuffer).toString();
 
console.log("RAW BODY:", rawText);
 
const parsed = safeJsonParse(rawText);

console.log("PARSED:", parsed);

console.log("REDIRECT:", parsed?.data?.redirectUrl);
 
    
    const rawBody = await response.text();
    const parsedBody = safeJsonParse(rawBody) || rawBody;   

    if (!response.ok) {
      const errorMessage =
        typeof parsedBody === 'string'
          ? parsedBody
          : parsedBody?.message ||
            `PayGlocal initiate failed with status ${response.status}.`;

      console.error('PayGlocal initiate failed:', {
        merchantTxnId,
        status: response.status,
        body: parsedBody,
      });

      if (transactionStore) {
        transactionStore.upsert({
          merchantTxnId,
          status: 'INITIATE_FAILED',
          updatedAt: new Date().toISOString(),
          initiateResponse: parsedBody,
          lastError: errorMessage,
        });
      }

      throw new Error(errorMessage);
    }

    const redirectUrl = parsedBody?.data?.redirectUrl;
    const statusUrl = parsedBody?.data?.statusUrl || null;
console.log("Parsed Body:", parsedBody);
console.log("Redirect URL:", parsedBody?.data?.redirectUrl);
    if (!redirectUrl) {
      if (transactionStore) {
        transactionStore.upsert({
          merchantTxnId,
          status: 'INITIATE_FAILED',
          updatedAt: new Date().toISOString(),
          initiateResponse: parsedBody,
          lastError: 'PayGlocal did not return redirectUrl.',
        });
      }

      throw new Error('PayGlocal did not return a redirect URL.');
    }


    if (transactionStore) {
      transactionStore.upsert({
        merchantTxnId,
        status: 'INITIATED',
        updatedAt: new Date().toISOString(),
        redirectUrl,
        statusUrl,
        initiateResponse: parsedBody,
        lastError: null,
      });
    }

    return {
      ok: true,
      merchantTxnId,
      redirectUrl,
      statusUrl,
    };
  } catch (error) {
    if (transactionStore) {
      transactionStore.upsert({
        merchantTxnId,
        status: 'INITIATE_FAILED',
        updatedAt: new Date().toISOString(),
        lastError: error.message || 'Unable to start subscription.',
      });
    }
    throw error;
  }
}

function getFailureReason(callbackPayload) {
  return (
    callbackPayload?.failureReason ||
    callbackPayload?.message ||
    callbackPayload?.statusMessage ||
    null
  );
}

async function handleCallback(request, response, url) {
  const rawBody = await readRequestBody(request, config.maxBodySizeBytes);
  const parsedBody = parseRequestBody(
    rawBody,
    String(request.headers['content-type'] || '').toLowerCase(),
  );
  const xGlToken = extractXGlToken(parsedBody, request, url);

  if (!xGlToken) {
    const location = buildRedirectUrl(config.failureRedirectUrl, {
      reason: 'Missing payment token',
    });
    redirectTo(response, location);
    return;
  }

  const decodedResult = await decodeCallbackToken(xGlToken);
  const callbackPayload = decodedResult.payload;
  const merchantTxnId = String(callbackPayload?.merchantTxnId || '').trim();
  const gid = callbackPayload?.gid || callbackPayload?.['x-gl-gid'] || null;
  const status = String(callbackPayload?.status || 'UNKNOWN').trim().toUpperCase();
  const reason = getFailureReason(callbackPayload);
  const now = new Date().toISOString();

  if (!merchantTxnId) {
    const location = buildRedirectUrl(config.failureRedirectUrl, {
      reason: 'Missing merchantTxnId in callback',
      status,
    });
    redirectTo(response, location);
    return;
  }

  const existing = transactionStore ? transactionStore.get(merchantTxnId) || {} : {};
  if (transactionStore) {
    transactionStore.upsert({
      ...existing,
      merchantTxnId,
      gid,
      status,
      callbackVerified: decodedResult.verified,
      callbackReceivedAt: now,
      callbackPayload,
      updatedAt: now,
      lastError: reason,
    });
  }

  console.log('Callback received:', {
    merchantTxnId,
    gid,
    status,
    verified: decodedResult.verified,
  });

  const isSuccess = SUCCESS_STATUSES.has(status);
  const redirectLocation = buildRedirectUrl(
    isSuccess ? config.successRedirectUrl : config.failureRedirectUrl,
    {
      merchantTxnId,
      txnId: merchantTxnId,
      gid,
      status,
      amount: callbackPayload?.Amount || callbackPayload?.amount || existing.chargeAmount,
      tier: existing.tier,
      billingCycle: existing.billingCycle,
      reason,
    },
  );

  redirectTo(response, redirectLocation);
}

async function handleRequest(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const requestOrigin = request.headers.origin || '';
  const corsOrigin = getAllowedCorsOrigin(requestOrigin, config.allowedOrigins);
  const isApiRoute =
    url.pathname === '/health' || url.pathname === '/api/plans' || url.pathname.startsWith('/api/');

  if (request.method === 'OPTIONS') {
    if (isApiRoute && requestOrigin && !corsOrigin) {
      sendJson(response, 403, { ok: false, message: 'Origin not allowed.' });
      return;
    }

    setCorsHeaders(response, corsOrigin);
    response.writeHead(204);
    response.end();
    return;
  }

  if (isApiRoute && requestOrigin && !corsOrigin) {
    sendJson(response, 403, { ok: false, message: 'Origin not allowed.' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(
      response,
      200,
      {
        ok: true,
        env: process.env.NODE_ENV || 'development',
        verifyCallbackSignature: config.verifyCallbackSignature,
        callbackPath: new URL(config.callbackUrl).pathname,
        transactionCount: transactionStore ? transactionStore.size() : null,
      },
      corsOrigin,
    );
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/plans') {
    sendJson(response, 200, buildPlansResponse(), corsOrigin);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/subscriptions/status') {
    const merchantTxnId = url.searchParams.get('merchantTxnId');
    if (!merchantTxnId) {
      sendJson(
        response,
        400,
        { ok: false, message: 'merchantTxnId query parameter is required.' },
        corsOrigin,
      );
      return;
    }

    if (!transactionStore) {
      sendJson(
        response,
        400,
        { ok: false, message: 'Transaction storage is disabled.' },
        corsOrigin,
      );
      return;
    }

    const transaction = transactionStore.get(merchantTxnId);
    if (!transaction) {
      sendJson(
        response,
        404,
        { ok: false, message: 'Transaction not found.' },
        corsOrigin,
      );
      return;
    }

    sendJson(response, 200, { ok: true, transaction }, corsOrigin);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/subscriptions/initiate') {
    try {
      const rawBody = await readRequestBody(request, config.maxBodySizeBytes);
      const parsedBody = parseRequestBody(
        rawBody,
        String(request.headers['content-type'] || '').toLowerCase(),
      );
      const result = await initiateSubscription(parsedBody);
      sendJson(response, 200, result, corsOrigin);
      return;
    } catch (error) {
      const statusCode =
        error.message && error.message.startsWith('tier must be')
          ? 400
          : error.message && error.message.startsWith('billingCycle must be')
            ? 400
            : error.message && error.message.includes('Request body')
              ? 400
              : 502;

      sendJson(
        response,
        statusCode,
        {
          ok: false,
          message: error.message || 'Unable to start subscription.',
        },
        corsOrigin,
      );
      return;
    }
  }

  if (request.method === 'POST' && url.pathname === '/callbackurl') {
    try {
      await handleCallback(request, response, url);
      return;
    } catch (error) {
      console.error('Callback error:', error.message);
      const redirectLocation = buildRedirectUrl(config.failureRedirectUrl, {
        reason: error.message || 'Callback processing failed.',
      });
      redirectTo(response, redirectLocation);
      return;
    }
  }

  sendJson(response, 404, { ok: false, message: 'Not found.' }, corsOrigin);
}

const server = http.createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error('Server error:', error.message);
    if (!response.headersSent) {
      sendJson(response, 500, { ok: false, message: 'Internal server error.' });
      return;
    }
 
    response.end();
  });
});

server.requestTimeout = config.requestTimeoutMs;
server.headersTimeout = config.headersTimeoutMs;

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Port ${config.port} is already in use. Stop the existing server or change PORT in .env.`,
    );
    process.exitCode = 1;
    return;
  }

  console.error('Server startup error:', error.message);
  process.exitCode = 1;
});

server.listen(config.port, config.host, () => {
  console.log(`Subscription server listening on http://${config.host}:${config.port}`);
  console.log(
    `Frontend should POST http://${config.host}:${config.port}/api/subscriptions/initiate`,
  );
  console.log(`Callback URL configured as: ${config.callbackUrl}`);
  console.log(
    `Transaction store: ${
      transactionStore ? config.transactionStorePath : 'disabled'
    }`,
  );
  console.log(
    `Callback signature verification: ${
      config.verifyCallbackSignature ? 'enabled' : 'disabled'
    }`,
  );
});
