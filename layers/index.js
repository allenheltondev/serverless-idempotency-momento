const { SimpleCacheClient, CacheGetStatus } = require('@gomomento/sdk');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { StatusCodes } = require('http-status-codes');
const hash = require('object-hash');

const IDEMPOTENCY_CACHE = 'idempotency-cache';
const PAYLOAD_MISMATCH_ERROR = 'The payload in the request does not match the original payload with the provided idempotency key.';
const REQUEST_IN_PROGRESS_ERROR = 'The original request with the matching idempotency key is still being processed.';
const secretsManager = new SecretsManagerClient();
let momentoClient;
let momentoAuthToken;

exports.getCacheClient = async () => {
  if (!momentoClient) {
    const authToken = await exports.getCacheAuthToken();
    const cacheClient = new SimpleCacheClient(authToken, Number(process.env.CACHE_TTL));
    momentoClient = cacheClient;

    try{
      await momentoClient.createCache(IDEMPOTENCY_CACHE);
    } catch(err){
      console.info(err);
    }
  }
  return momentoClient;
};

exports.getCacheAuthToken = async () => {
  if (!momentoAuthToken) {
    const command = new GetSecretValueCommand({ SecretId: process.env.CACHE_AUTH_TOKEN_SECRET });
    const result = await secretsManager.send(command);
    momentoAuthToken = JSON.parse(result.SecretString).auth_token;
  }
  return momentoAuthToken;
};

exports.validateCache = async (idempotencyKey, payload) => {
  const cacheClient = await exports.getCacheClient();
  const cacheResponse = await cacheClient.get(IDEMPOTENCY_CACHE, idempotencyKey);
  if (cacheResponse.status == CacheGetStatus.Miss) {
    const cacheValue = {
      hash: hash(payload),
      inProgress: true
    };

    await cacheClient.set(IDEMPOTENCY_CACHE, idempotencyKey, JSON.stringify(cacheValue));
  } else if (cacheResponse.status == CacheGetStatus.Hit){
    const cacheValue = JSON.parse(cacheResponse.text());
    const payloadHash = hash(payload);
    if(payloadHash !== cacheValue.hash){
      return {
        statusCode: StatusCodes.BAD_REQUEST,
        error: PAYLOAD_MISMATCH_ERROR
      };
    }
    console.log(cacheValue);
    if(cacheValue.inProgress){
      return {
        statusCode: StatusCodes.ACCEPTED,
        error: REQUEST_IN_PROGRESS_ERROR
      };
    }

    return {
      statusCode: cacheValue.statusCode,
      body: cacheValue.result
    }
  }
};

exports.finalizeCache = async (idempotencyKey, statusCode, result) => {
  const cacheClient = await exports.getCacheClient();
  if(statusCode >= 400) {
    // If the request resulted in an error, do not save the response and allow the caller to attempt to fix it
    await cacheClient.delete(IDEMPOTENCY_CACHE, idempotencyKey);
  } else {
    const cacheResponse = await cacheClient.get(IDEMPOTENCY_CACHE, idempotencyKey);
    const existingCacheValue = JSON.parse(cacheResponse.text());

    const cacheResult = {
      hash: existingCacheValue.hash,
      result: result,
      statusCode
    };

    await cacheClient.set(IDEMPOTENCY_CACHE, idempotencyKey, JSON.stringify(cacheResult));
  }
};