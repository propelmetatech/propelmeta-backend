const { importPKCS8, CompactSign } = require("jose");
const { JWS_ALGORITHM } = require('../utils/constants');
const { generateDigestObject, generateJWSHeaderObject } = require('../utils/helper');

/**
 * Generates a JWS token to send in the initiate request header (Encrypt transaction payload)
 *
 * @param {String} payload jweToken/payload which has to be (required)
 * @param {String} privateKey public key provided by payglocal (required)
 * @param {String} merchantId unique merchantId provided by payglocal (optional)
 * @param {String} privateKeyId kid associated with private key (optional)
 */
module.exports = async ({ payload, privateKey, merchantId, privateKeyId }) => {

  const cryptoPrivateKey = await importPKCS8(privateKey, JWS_ALGORITHM);
  const digestObject = generateDigestObject({ payload });
  const headerObject = generateJWSHeaderObject({ merchantId, kid: privateKeyId });

  const jws = await new CompactSign(
    new TextEncoder().encode(JSON.stringify(digestObject))
  )
    .setProtectedHeader(headerObject)
    .sign(cryptoPrivateKey);

  return jws;
};