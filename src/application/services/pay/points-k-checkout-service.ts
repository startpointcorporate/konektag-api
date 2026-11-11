import { apiPaymentCheckoutService } from './api-payment-checkout-service.ts';
import { PaymentContextResolutionError, PaymentContextResolver, publicPaymentContext } from './payment-context-resolver.ts';
import { konektagFrappeSite, routeKonektagFlow, type KonektagSiteRoute } from '../../shared/konektag-site.ts';
import type { FrappeSite } from '../../marketplace-transactions/frappe-site.ts';
import { minorDigits } from './money-unit.ts';

export class PointsKCheckoutError extends Error {
  constructor(readonly code: string, readonly detail: Record<string, unknown> = {}) { super(code); }
}

type Input = { keycloakId: string; userId: string; country: string; customer: string; quotation: string };
type Deps = {
  route?: (country: string) => Promise<KonektagSiteRoute>;
  site?: (route: KonektagSiteRoute) => FrappeSite;
  context?: PaymentContextResolver;
  createOrder?: typeof apiPaymentCheckoutService.createWalletRechargeOrder;
};

const n = (value: unknown) => Number(value);
const total = (doc: any) => Number(doc.disable_rounded_total) === 1 ? n(doc.grand_total) : n(doc.rounded_total);

async function owned(input: Input, deps: Deps) {
  const route = await (deps.route ?? (country => routeKonektagFlow('points-k-checkout', country)))(input.country);
  const site = (deps.site ?? konektagFrappeSite)(route);
  const [customer, quotation] = await Promise.all([site.get('Customer', input.customer), site.get('Quotation', input.quotation)]);
  if (customer?.name !== input.customer || customer.alias !== input.keycloakId)
    throw new PointsKCheckoutError('CUSTOMER_NOT_OWNED');
  const owners = await site.list('Customer', [['lead_name', '=', quotation.party_name]], ['name'], 2);
  if (quotation?.name !== input.quotation || ![0, 1].includes(Number(quotation.docstatus))
    || quotation.quotation_to !== 'Lead' || owners.length !== 1 || owners[0].name !== customer.name)
    throw new PointsKCheckoutError('QUOTATION_NOT_OWNED');
  if (!Array.isArray(quotation.items) || quotation.items.length !== 1 || !(total(quotation) > 0))
    throw new PointsKCheckoutError('QUOTATION_INCONSISTENT');
  const modes = await site.list('Mode of Payment', [['enabled', '=', 1]], ['name', 'type', 'enabled'], 100);
  return { route, site, customer, quotation, modes: modes.filter(mode => Number(mode.enabled) === 1) };
}

export async function readPointsKCheckout(input: Input, deps: Deps = {}) {
  const state = await owned(input, deps);
  // Provider eligibility controls payment availability, not native ERPNext preparation.
  let paymentContext = null;
  let paymentContextError: string | null = null;
  try {
    const context = await (deps.context ?? new PaymentContextResolver()).resolveForRoute(state.route, 'link_payment');
    if (context.currency !== state.quotation.currency) throw new PointsKCheckoutError('PAYMENT_CURRENCY_MISMATCH');
    paymentContext = publicPaymentContext(context);
  } catch (error) {
    if (!(error instanceof PaymentContextResolutionError)) throw error;
    paymentContextError = error.code;
  }
  return {
    site: state.route.site, customer: state.customer.name,
    quotation: state.quotation,
    amount: total(state.quotation), currency: state.quotation.currency,
    modesOfPayment: state.modes.map(mode => ({ name: mode.name, type: mode.type ?? null })),
    paymentContext, paymentContextError,
  };
}

export async function createPointsKCheckout(input: Input & { modeOfPayment: string }, deps: Deps = {}) {
  const state = await owned(input, deps);
  if (!state.modes.some(mode => mode.name === input.modeOfPayment)) throw new PointsKCheckoutError('MODE_OF_PAYMENT_NOT_ALLOWED');
  let quotation = state.quotation;
  if (Number(quotation.docstatus) === 0) quotation = await state.site.call('frappe.client.submit', { doc: quotation });
  if (Number(quotation.docstatus) !== 1) throw new PointsKCheckoutError('QUOTATION_NOT_SUBMITTED');

  let salesOrder: any;
  const existingOrders = await state.site.list('Sales Order', [['docstatus', '=', 1]], ['name', 'customer', 'currency'], 100);
  for (const row of existingOrders) {
    const doc = await state.site.get('Sales Order', row.name);
    if (doc.customer === state.customer.name && doc.items?.some((item: any) => item.prevdoc_docname === quotation.name)) { salesOrder = doc; break; }
  }
  if (!salesOrder) {
    salesOrder = await state.site.call('erpnext.selling.doctype.quotation.quotation.make_sales_order', { source_name: quotation.name });
    salesOrder = await state.site.insert('Sales Order', salesOrder);
    salesOrder = await state.site.call('frappe.client.submit', { doc: salesOrder });
  }
  if (Number(salesOrder.docstatus) !== 1 || salesOrder.customer !== state.customer.name
    || !salesOrder.items?.some((item: any) => item.prevdoc_docname === quotation.name))
    throw new PointsKCheckoutError('SALES_ORDER_INCONSISTENT');

  let paymentRequest: any;
  const requests = await state.site.list('Payment Request', [['reference_doctype', '=', 'Sales Order'], ['reference_name', '=', salesOrder.name]], ['name'], 10);
  if (requests[0]) paymentRequest = await state.site.get('Payment Request', requests[0].name);
  else {
    // Native submission may invoke a default gateway even when mute_email=1.
    // Points K funding belongs to the existing API checkout, never to this ERPNext step.
    const gateways = await state.site.list('Payment Gateway Account',
      [['company', '=', salesOrder.company], ['is_default', '=', 1]], ['name'], 1);
    if (gateways.length) throw new PointsKCheckoutError('PAYMENT_REQUEST_EXTERNAL_GATEWAY_CONFIGURED');
    paymentRequest = await state.site.call('erpnext.accounts.doctype.payment_request.payment_request.make_payment_request', {
      dt: 'Sales Order', dn: salesOrder.name, submit_doc: 1, mute_email: 1, mode_of_payment: input.modeOfPayment,
    });
  }
  if (Number(paymentRequest.docstatus) !== 1 || paymentRequest.reference_doctype !== 'Sales Order'
    || paymentRequest.reference_name !== salesOrder.name || paymentRequest.party !== state.customer.name)
    throw new PointsKCheckoutError('PAYMENT_REQUEST_INCONSISTENT');
  const paymentRequestTotal = n(paymentRequest.grand_total);
  if (!(paymentRequestTotal > 0) || paymentRequest.currency !== quotation.currency) throw new PointsKCheckoutError('PAYMENT_REQUEST_INCONSISTENT');
  const amount = Math.round(paymentRequestTotal * (10 ** minorDigits(paymentRequest.currency)));

  const item = quotation.items[0];
  const order = await (deps.createOrder ?? apiPaymentCheckoutService.createWalletRechargeOrder)({
    targetUserId: input.userId, amount, currency: paymentRequest.currency,
    paymentCountry: state.route.paymentCountry, konektagSite: { slug: state.route.slug },
    metadata: { erpnextPointsK: { version: 1, site: state.route.site, customer: state.customer.name,
      quotation: quotation.name, salesOrder: salesOrder.name, paymentRequest: paymentRequest.name,
      itemCode: item.item_code, quantityK: n(item.qty) } },
  });
  return { quotation: quotation.name, salesOrder: salesOrder.name, paymentRequest: paymentRequest.name,
    amount: paymentRequestTotal, amountMinor: amount, currency: paymentRequest.currency,
    order: order.order, checkoutToken: order.checkoutToken };
}
