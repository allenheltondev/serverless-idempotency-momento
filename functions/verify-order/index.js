const shared = require('/opt/nodejs/index');

exports.handler = async (state) => {
  try {
      const idempotencyResult = await shared.validateCache(state.idempotencyKey, state.items);
      if (idempotencyResult?.error) {
        return {
          statusCode: idempotencyResult.statusCode,
          message: idempotencyResult.error
        };
      } else if (idempotencyResult?.body) {
        return idempotencyResult;
      }

    return { isNewOrder: true };
  } catch (err) {
    console.error(err);
    const response = {
      statusCode: 500,
      message: 'Something went wrong.'
    };

    await shared.finalizeCache(state.idempotencyKey, response.statusCode);
    return response;
  }
};