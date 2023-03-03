const { SimpleCacheClient, EnvMomentoTokenProvider, Configurations, CacheGet, CacheSetIfNotExists } = require('@gomomento/sdk');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const hash = require('object-hash');

const IDEMPOTENCY_CACHE = 'idempotency-cache';
const PAYLOAD_MISMATCH_ERROR = 'The payload in the request does not match the original payload with the provided idempotency key.';
const REQUEST_IN_PROGRESS_ERROR = 'The original request with the matching idempotency key is still being processed.';
const secretsManager = new SecretsManagerClient();

let momentoClient;
let cachedSecret;

exports.validateCache = async (idempotencyKey, payload) => {
  const momento = await getCacheClient();
  let cacheResponse = await momento.get(IDEMPOTENCY_CACHE, idempotencyKey);
  if (cacheResponse instanceof CacheGet.Miss) {
    const cacheValue = {
      hash: hash(payload),
      inProgress: true
    };

    const setResponse = await momento.setIfNotExists(IDEMPOTENCY_CACHE, idempotencyKey, JSON.stringify(cacheValue));
    if (setResponse instanceof CacheSetIfNotExists.NotStored) {
      // This means there were two competing calls at approximately the same time. 
      // Check the stored payload and process accordingly
      cacheResponse = await momento.get(IDEMPOTENCY_CACHE, idempotencyKey);
      const response = processIdempotentHit(payload, cacheResponse);
      return response;
    }
  } else if (cacheResponse instanceof CacheGet.Hit) {
    const response = processIdempotentHit(payload, cacheResponse);
    return response;
  }
};

const processIdempotentHit = (payload, value) => {
  const cacheValue = JSON.parse(value.valueString());
  const payloadHash = hash(payload);
  if (payloadHash !== cacheValue.hash) {
    return {
      statusCode: 400,
      error: PAYLOAD_MISMATCH_ERROR
    };
  }

  if (cacheValue.inProgress) {
    return {
      statusCode: 202,
      error: REQUEST_IN_PROGRESS_ERROR
    };
  }

  return {
    statusCode: cacheValue.statusCode,
    body: cacheValue.result
  }
};

exports.finalizeCache = async (idempotencyKey, statusCode, result) => {
  const momento = await getCacheClient();
  if (statusCode >= 400) {
    // If the request resulted in an error, do not save the response and allow the caller to attempt to fix it
    await momento.delete(IDEMPOTENCY_CACHE, idempotencyKey);
  } else {
    const cacheResponse = await momento.get(IDEMPOTENCY_CACHE, idempotencyKey);
    const existingCacheValue = JSON.parse(cacheResponse.valueString());

    const cacheResult = {
      hash: existingCacheValue.hash,
      result: result,
      statusCode
    };

    await momento.set(IDEMPOTENCY_CACHE, idempotencyKey, JSON.stringify(cacheResult));
  }
};

const getCacheClient = async (caches = [IDEMPOTENCY_CACHE]) => {
  if (!momentoClient) {
    const authToken = await getCacheAuthToken();
    process.env.AUTH_TOKEN = authToken;
    const credentials = new EnvMomentoTokenProvider({ environmentVariableName: 'AUTH_TOKEN' });

    const cacheClient = new SimpleCacheClient({
      configuration: Configurations.Laptop.latest(),
      credentialProvider: credentials,
      defaultTtlSeconds: Number(process.env.CACHE_TTL)
    });
    momentoClient = cacheClient;

    await initializeCaches(caches);
  }

  return momentoClient;
};

const getCacheAuthToken = async () => {
  if (!cachedSecret) {
    const command = new GetSecretValueCommand({ SecretId: process.env.MOMENTO_SECRET });
    const result = await secretsManager.send(command);
    cachedSecret = JSON.parse(result.SecretString).auth_token;
  }
  return cachedSecret;
};

const initializeCaches = async (caches) => {
  if (caches?.length) {
    const listCachesResponse = await momentoClient.listCaches();
    const cachesToAdd = caches.filter(c => !listCachesResponse.caches.some(cache => cache.name == c));
    for (const cacheToAdd of cachesToAdd) {
      await momentoClient.createCache(cacheToAdd)
    }
  }
}