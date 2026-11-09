const json = schema => ({ 'application/json': { schema } });
const error = codes => ({ type: 'object', required: ['error'], properties: { error: { type: 'string', enum: codes } } });
const auth = [{ session: [] }, { userApiKey: [] }, { bearer: [] }, { keycloakOAuth: [] }];

export function documentPointsKWebContracts(paths) {
  const publicLink = paths['/api/pay/payment-links']?.get;
  if (publicLink) {
    publicLink.description = 'Projection publique par slug. Aucun secret, identifiant interne ou preuve de valorisation n’est exposé.';
    publicLink.security = [];
    publicLink.responses['200'].content = json({ type: 'object', required: ['links'], properties: { links: { type: 'array', maxItems: 1, items: {
      type: 'object', required: ['status'], properties: { status: { enum: ['Active', 'Expired', 'Used'] }, etablissement: { type: 'string' },
        amount: { type: 'integer', minimum: 1, description: 'Montant en unité mineure ISO 4217.' }, currency: { type: 'string', pattern: '^[A-Z]{3}$' },
        quantityK: { type: 'integer', minimum: 1 }, description: { type: 'string' }, reference: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' } },
    } } } });
    publicLink.responses['500'] = { description: 'Projection indisponible sans fuite de détail interne.', content: json(error(['LINK_UNAVAILABLE'])) };
  }

  const resume = paths['/api/pay/payment-links/{slug}/resume']?.post;
  if (resume) {
    resume.description = 'Crée ou reprend idempotemment le paiement en attente du payeur authentifié pour un Link Pay actif.';
    resume.security = auth;
    resume.responses['200'].content = json({ type: 'object', required: ['success', 'pendingId'], properties: { success: { const: true }, pendingId: { type: 'string', format: 'uuid' } } });
    resume.responses['401'] = { description: 'Authentification utilisateur requise.', content: json(error(['UNAUTHORIZED'])) };
    resume.responses['404'] = { description: 'Lien absent, expiré ou déjà utilisé.', content: json(error(['LINK_NOT_AVAILABLE'])) };
  }

  const consume = paths['/api/pay/pay-link']?.post;
  if (consume) {
    consume.description = 'Consomme par slug un Link Pay avec authentification, KYC, contrôle de rôle et rejeu idempotent lié au payeur.';
    consume.requestBody.content['application/json'].schema = { type: 'object', required: ['slug'], properties: { slug: { type: 'string', minLength: 1 }, payer_email: { type: 'string', format: 'email' }, transaction_id: { type: 'string' } } };
    consume.responses['201'].content = json({ type: 'object', required: ['success', 'message', 'kOperationId'], properties: { success: { const: true }, message: { const: 'Paiement confirme' }, kOperationId: { type: 'string', format: 'uuid' } } });
  }

  const recharge = paths['/api/pay/recharges']?.post;
  if (recharge) {
    recharge.description = 'Crée pour l’utilisateur authentifié une recharge payable. amount est toujours un entier en unité mineure (EUR 2500 = 25,00 EUR; XAF 2500 = 2500 XAF). Le contexte de règlement doit être disponible dans PostgreSQL : ce parcours ne déclenche aucune projection ni synchronisation Frappe/ERPNext. La recette isolée double la base et les prestataires; aucune confirmation live n’est requise.';
    recharge.parameters.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', minLength: 1 }, description: 'Clé de rejeu du middleware financier.' });
    recharge.requestBody.content['application/json'].schema = { type: 'object', required: ['amount', 'currency', 'paymentCountry'], properties: { amount: { type: 'integer', minimum: 1, description: 'Montant en unité mineure.' }, currency: { type: 'string', enum: ['EUR','XOF','XAF','USD','LBP','AOA','CDF','GNF','ETB','GHS','KES','LSL','MWK','NGN','RWF','SLL','TZS','UGX','ZMW'] }, paymentCountry: { type: 'string', pattern: '^[A-Z]{2,3}$' } } };
    recharge.responses['201'].content = json({ type: 'object', required: ['id','status','checkoutUrl','amountMinor','amountUnit','currency','paymentCountry'], properties: { id: { type: 'string', format: 'uuid' }, status: { enum: ['pending'] }, checkoutUrl: { type: 'string', format: 'uri' }, amountMinor: { type: 'integer', minimum: 1 }, amountUnit: { const: 'MINOR' }, currency: { type: 'string' }, paymentCountry: { type: 'string' } } });
    recharge.responses['400'] = { description: 'Montant, devise ou pays invalide.', content: json({ type: 'object', required: ['error'], properties: { error: { type: 'string' } } }) };
  }

  const quote = paths['/api/k/send/quote']?.post;
  if (quote) quote.description = 'Valorise une quantité entière de Points K avant création du transfert K_SEND.';
  const send = paths['/api/k/send']?.post;
  if (send) send.description = 'Crée un transfert K_SEND du solde de l’utilisateur authentifié vers un utilisateur Konektag; ce n’est pas un achat-cadeau.';
  const confirm = paths['/api/k/send/{id}']?.post;
  if (confirm) {
    confirm.description = 'Sans authorizationId/otp, émet le challenge OTP (202). Avec les deux champs, confirme idempotemment le transfert; Funded est terminal.';
    confirm.requestBody.content['application/json'].schema = { type: 'object', properties: { authorizationId: { type: 'string', format: 'uuid' }, otp: { type: 'string', pattern: '^\\d{6}$' } } };
  }
}
