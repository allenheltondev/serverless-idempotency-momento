const shared = require('/opt/nodejs/index');

exports.handler = async (state) => {
  await shared.finalizeCache(state.idempotencyKey, state.statusCode, state.result);
};