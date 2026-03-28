const crypto = require("node:crypto");
const {
  JWS_ALGORITHM,
  DIGEST_ALGORITHM,
  TOKEN_EXPIRY_TIME_IN_MILLISECONDS,
  JWE_ENCRYPTION_METHOD,
  JWE_ALGORITHM,
} = require("../utils/constants");

const createIssuedAt = () => Date.now();
const createExpiry = () => Date.now() + TOKEN_EXPIRY_TIME_IN_MILLISECONDS;

exports.generateDigestObject = ({ payload }) => ({
  digest: crypto.createHash("sha256").update(payload).digest("base64"),
  digestAlgorithm: DIGEST_ALGORITHM,
  exp: createExpiry(),
  iat: createIssuedAt(),
});

exports.generateJWSHeaderObject = ({ merchantId, kid }) => ({
  alg: JWS_ALGORITHM,
  kid,
  "x-gl-merchantId": merchantId,
  "issued-by": merchantId,
  "is-digested": "true",
  "x-gl-enc": "true",
});

exports.generateJWEHeaderObject = ({ merchantId, kid }) => ({
  "issued-by": merchantId,
  enc: JWE_ENCRYPTION_METHOD,
  exp: createExpiry(),
  iat: createIssuedAt(),
  alg: JWE_ALGORITHM,
  kid,
});
