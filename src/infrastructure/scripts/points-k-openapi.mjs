const json = schema => ({ 'application/json': { schema } });
const errorSchema = { type: 'object', required: ['error'], properties: { error: { type: 'string' } } };

export function documentPointsKWebContracts(paths) {
  const recharge = paths['/api/pay/recharges']?.post;
  if (recharge) {
    recharge.description = 'Crée une recharge de Points K pour l’utilisateur authentifié. Le montant est un entier en unité mineure. Le pays de paiement et le site Konektag sont résolus côté serveur depuis le pays de résidence; toute valeur paymentCountry envoyée par le client est ignorée.';
    recharge.requestBody.content['application/json'].schema = {
      type: 'object', required: ['amount', 'currency'], additionalProperties: true,
      properties: {
        amount: { type: 'integer', minimum: 1, description: 'Montant en unité mineure ISO 4217 (EUR 2500 = 25,00 EUR; XAF 2500 = 2500 XAF).' },
        currency: { type: 'string', pattern: '^[A-Z]{3}$' },
      },
    };
    recharge.responses['201'].content = json({
      type: 'object', required: ['id', 'status', 'checkoutUrl', 'konektagSite', 'paymentContext'],
      properties: {
        id: { type: 'string', format: 'uuid' }, status: { type: 'string' }, checkoutUrl: { type: 'string', format: 'uri' },
        konektagSite: { type: 'string' }, paymentContext: { type: 'object', additionalProperties: true },
      },
    });
    recharge.responses['400'] = { description: 'Montant ou devise invalide.', content: json(errorSchema) };
    recharge.responses['401'] = { description: 'Session absente.', content: json(errorSchema) };
    recharge.responses['404'] = { description: 'Acheteur, contexte d’achat Points K ou entité légale introuvable pour le pays résolu.', content: json(errorSchema) };
    recharge.responses['409'] = { description: 'PAYMENT_CURRENCY_MISMATCH (devise différente du contexte résolu côté serveur, renvoyée dans currency) ou CHECKOUT_ALREADY_EXISTS (id de la recharge existante).', content: json({ ...errorSchema, properties: { ...errorSchema.properties, currency: { type: 'string' }, id: { type: 'string', format: 'uuid' } } }) };
    recharge.responses['422'] = { description: 'Pays de résidence invalide ou sans règle pays.', content: json(errorSchema) };
    recharge.responses['503'] = { description: 'Site Konektag ou contexte de paiement temporairement non résolu.', content: json(errorSchema) };
  }

  const quote = paths['/api/k/send/quote']?.post;
  if (quote) {
    quote.description = 'Valorise une quantité entière de Points K avant création d’un transfert K_SEND.';
    quote.requestBody.content['application/json'].schema = {
      type: 'object', required: ['quantityK'], properties: { quantityK: { type: 'integer', minimum: 1 } }, additionalProperties: false,
    };
  }

  const send = paths['/api/k/send']?.post;
  if (send) {
    send.description = 'Crée depuis le solde de l’utilisateur authentifié un transfert K_SEND vers un utilisateur Konektag; ce contrat n’est pas un achat-cadeau.';
    send.requestBody.content['application/json'].schema = {
      type: 'object', required: ['recipientUserId', 'quantityK'],
      properties: { recipientUserId: { type: 'string' }, quantityK: { type: 'integer', minimum: 1 } }, additionalProperties: false,
    };
  }

  const confirm = paths['/api/k/send/{id}']?.post;
  if (confirm) {
    confirm.description = 'Sans authorizationId/otp, émet le challenge OTP (202). Avec les deux champs, confirme idempotemment le transfert; Funded est terminal.';
    confirm.requestBody.content['application/json'].schema = {
      type: 'object', additionalProperties: false,
      properties: { authorizationId: { type: 'string', format: 'uuid' }, otp: { type: 'string', pattern: '^\\d{6}$' } },
      dependentRequired: { authorizationId: ['otp'], otp: ['authorizationId'] },
    };
    confirm.responses['202'] = { description: 'Challenge OTP émis (requiresOtp=true).', content: json({ type: 'object', required: ['requiresOtp'], properties: { requiresOtp: { const: true } }, additionalProperties: true }) };
    confirm.responses['403'] = { description: 'Transfert d’un autre utilisateur, ou USER_KYC_REQUIRED.', content: json(errorSchema) };
    confirm.responses['409'] = { description: 'K_SEND_STATE_CONFLICT, K_SEND_IDEMPOTENCY_CONFLICT ou K_SEND_INSUFFICIENT.', content: json(errorSchema) };
  }

  const recipient = paths['/api/k/send/recipient']?.post;
  if (recipient) {
    recipient.requestBody.content['application/json'].schema = {
      type: 'object', required: ['recipientUserId', 'fullName'],
      properties: { recipientUserId: { type: 'string' }, fullName: { type: 'string', minLength: 1 } }, additionalProperties: false,
    };
  }
}
