// Match the provider routes currently implemented by classic Checkout.
// The Frappe Payment Context still selects the approved corridor.
export function supportsProPaymentProvider(
  provider: { provider: string; paymentMethod: string }, currency: string, country: string,
): boolean {
  if (provider.provider === 'pawapay' && provider.paymentMethod === 'mobile_money') {
    return currency === 'XAF' && ['CM', 'CG', 'GA'].includes(country);
  }
  if (provider.provider === 'stripe' && provider.paymentMethod === 'card') {
    return ['EUR', 'XOF', 'AOA', 'CDF'].includes(currency);
  }
  return false;
}
