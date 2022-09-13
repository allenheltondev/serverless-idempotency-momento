const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const shared = require('/opt/nodejs/index');
const { ulid, decodeTime } = require('ulid');
const ddb = new DynamoDBClient();

exports.handler = async (event) => {
  const idempotencyKey = event.headers?.['idempotency-key'];
  try {
    const input = JSON.parse(event.body);

    if (idempotencyKey) {
      const idempotencyResult = await shared.validateCache(idempotencyKey, input);
      if (idempotencyResult?.error) {
        return {
          statusCode: idempotencyResult.statusCode,
          body: JSON.stringify({ message: idempotencyResult.error })
        };
      } else if (idempotencyResult?.body) {
        return idempotencyResult;
      }
    }

    const id = await exports.saveGoat(input);
    const response = {
      statusCode: 201,
      body: JSON.stringify({ id })
    }

    if (idempotencyKey) {
      await shared.finalizeCache(idempotencyKey, response.statusCode, response.body);
    }

    return response;

  } catch (err) {
    console.error(err);
    const response = {
      statusCode: 500,
      body: JSON.stringify({ message: 'Something went wrong.' })
    };

    await shared.finalizeCache(idempotencyKey, response.statusCode);
    return response;
  }
};

exports.saveGoat = async (input) => {
  const id = ulid();
  const goat = {
    pk: id,
    sk: 'goat#',
    name: input.name,
    breed: input.breed,
    owner: input.owner,
    GSI1PK: 'goat#',
    GSI1SK: new Date(decodeTime(id)).toISOString()
  };

  const command = new PutItemCommand({
    TableName: process.env.TABLE_NAME,
    Item: marshall(goat)
  });

  await ddb.send(command);

  return id;
};