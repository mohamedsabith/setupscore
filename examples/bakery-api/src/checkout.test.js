import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyCoupon } from './checkout.js';

test('applyCoupon gives 10% off with SAVE10', () => {
  assert.equal(applyCoupon(1000, 'SAVE10'), 900);
});

test('applyCoupon rejects an unknown coupon', () => {
  assert.throws(() => applyCoupon(1000, 'FAKE'), /Invalid coupon/);
});
