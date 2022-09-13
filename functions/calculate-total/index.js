exports.handler = async (state) => {
  const price = Number(state.price);
  const quantity = Number(state.quantity);

  return { total: price * quantity }
};