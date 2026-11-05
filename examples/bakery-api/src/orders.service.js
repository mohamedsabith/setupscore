// Orders: create an order and calculate its total
export function createOrder(items) {
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return { id: Date.now(), items, total, status: 'placed' };
}

// Cancel an order; delivered orders cannot be cancelled
export function cancelOrder(order) {
  if (order.status === 'delivered') throw new Error('Delivered orders cannot be cancelled');
  return { ...order, status: 'cancelled' };
}
