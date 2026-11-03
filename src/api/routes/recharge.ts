import type { RouteHandler } from '../http';
import { rechargeService } from '../../application/services/recharge-service.ts';
import { emailService } from '../../application/services/resend-service.ts';

const CURRENCY_LIMITS: Record<string, { min: number; max: number }> = {
  XAF: { min: 5000, max: 5000000 },
  XOF: { min: 5000, max: 5000000 },
  EUR: { min: 5, max: 1500 },
  USD: { min: 5, max: 2000 },
  LBP: { min: 1000000, max: 10000000 },
  AOA: { min: 5000, max: 2000000 },
  CDF: { min: 5000, max: 3000000 },
};

const CARD_METHODS = new Set(['Stripe', 'Google Pay', 'Apple Pay']);

export const POST: RouteHandler = async ({ request, locals }) => {
  try {
    const body = await request.json();
    const amount = parseInt(String(body.amount), 10);
    const currency = (body.currency || 'XOF').toUpperCase();
    const limits = CURRENCY_LIMITS[currency] || { min: 500, max: 5000000 };
    if (!amount || amount < limits.min) {
      return new Response(JSON.stringify({ error: `Montant minimum : ${limits.min.toLocaleString()} ${currency}` }), { status: 400 });
    }
    if (amount > limits.max) {
      return new Response(JSON.stringify({ error: `Montant maximum : ${limits.max.toLocaleString()} ${currency}` }), { status: 400 });
    }

    const user = locals.user;
    if (!user) {
      return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
    }

    const keycloakId = user.keycloak_id;
    const clientEmail = user.email || keycloakId;

    const method = body.paymentMethod;
    if (!['Mobile Money', 'Stripe', 'Google Pay', 'Apple Pay', 'Crypto'].includes(method)) {
      return new Response(JSON.stringify({ error: 'Mode de paiement invalide' }), { status: 400 });
    }
    if (CARD_METHODS.has(method)) {
      return new Response(JSON.stringify({ error: 'Les recharges par carte doivent être confirmées par le prestataire de paiement.' }), { status: 400 });
    }
    if (!body.country) {
      return new Response(JSON.stringify({ error: 'Pays requis' }), { status: 400 });
    }

    const { doc, projectionStatus } = await rechargeService.createRecharge({
      keycloakId,
      clientEmail,
      amount,
      currency: body.currency || 'XOF',
      paymentMethod: method,
      country: body.country,
      operator: body.operator || undefined,
      phoneNumber: body.phoneNumber || undefined,
      cryptoNetwork: body.cryptoNetwork || undefined,
      cryptoAddress: body.cryptoAddress || body.apayToken || body.gpayToken || undefined,
    });

    if (clientEmail) {
      emailService.sendTemplate('refillAccount', 'fr', clientEmail, {
        firstName: clientEmail.split('@')[0] || '',
        amount: amount.toString(),
        currency: body.currency || 'XOF',
        transactionDate: new Date().toLocaleDateString('fr-FR'),
        transactionReference: doc.name || '',
        paymentMethod: method,
        newBalance: 'Cf. dashboard',
        currentYear: new Date().getFullYear().toString(),
      }).catch(e => console.error('[recharge] Email failed:', e.message));
    }

    const response = projectionStatus === 'pending_reconciliation'
      ? { success: true, operationStatus: 'accepted', projectionStatus: 'pending_reconciliation', reference: doc.name, message: 'La recharge a été enregistrée mais son affichage peut être temporairement différé.' }
      : { success: true, recharge: doc };

    return new Response(JSON.stringify(response), { status: 201 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 400 });
  }
};
