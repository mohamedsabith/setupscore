import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrder } from './orders.service.js';

test('createOrder calculates the total', () => {
  const order = createOrder([{ price: 100, qty: 2 }, { price: 50, qty: 1 }]);
  assert.equal(order.total, 250);
  assert.equal(order.status, 'placed');
});

import { cancelOrder } from './orders.service.js';

test('cancelOrder cancels a placed order', () => {
  const order = createOrder([{ price: 100, qty: 1 }]);
  assert.equal(cancelOrder(order).status, 'cancelled');
});

test('cancelOrder refuses a delivered order', () => {
  assert.throws(() => cancelOrder({ status: 'delivered' }), /cannot be cancelled/);
});
