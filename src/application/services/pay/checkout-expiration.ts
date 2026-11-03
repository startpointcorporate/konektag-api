// One policy for public checkout expiry and fee-credit quote reservations.
export function checkoutExpirationMinutes(): number {
  const raw=Number(process.env.API_PAYMENT_CHECKOUT_EXPIRATION_MINUTES??60);
  return Number.isFinite(raw)?Math.max(5,Math.min(7*24*60,Math.trunc(raw))):60;
}
