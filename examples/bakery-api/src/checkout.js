// Checkout: apply a coupon code to an order total
const COUPONS = { SAVE10: 0.10, WELCOME20: 0.20 };

export function applyCoupon(total, code) {
  const discount = COUPONS[code];
  if (discount === undefined) throw new Error(`Invalid coupon: ${code}`);
  return Math.round(total * (1 - discount));
}
