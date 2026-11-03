/**
 * Resend transactional email service.
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_URL = 'https://api.resend.com/emails';
// En dev, tous les emails sont redirigés vers l'email propriétaire
const DEV_EMAIL = '2mbiwebingenierie@gmail.com';
const FROM = process.env.RESEND_FROM || 'Konektag <noreply@konektag.eu>';

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
  idempotencyKey?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

export async function sendEmail(payload: EmailPayload): Promise<boolean> {
  if (!RESEND_API_KEY) { console.error('[resend] RESEND_API_KEY is required'); return false; }
  const to = payload.to;
  const from = FROM;
  try {
    const res = await fetch(RESEND_URL, {
      signal: AbortSignal.timeout(30000),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        ...(payload.idempotencyKey ? { 'Idempotency-Key': payload.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: payload.subject,
        html: payload.html,
        ...(payload.attachments?.length ? {attachments: payload.attachments.map(({filename, content, contentType})=>({filename, content, ...(contentType?{content_type:contentType}:{})}))} : {}),
      }),
    });
    if (!res.ok) {
      await res.text();
      console.error('[resend] Send failed');
      return false;
    }
    console.log('[resend] Email sent');
    return true;
  } catch (e: any) {
    console.error('[resend] Send error');
    return false;
  }
}

/** Templates disponibles */
const TEMPLATES = {
  // Onboarding (templates Resend dashboard)
  confirmEmail: {
    fr: '9bb34808-c5a3-48db-8048-7bc5015e3308',
    en: 'c8676417-e47c-4319-a294-c5e261017bc4',
  },
  welcome: {
    fr: '32b3d3dc-b7ad-436b-ae24-88993e787e0a',
    en: 'a11c6d74-dec2-4526-84a6-9935236e4185',
  },
  // Password reset (defined locally, no Resend template)
  resetPassword: {
    fr: 'reset-password-fr', 
    en: 'reset-password-en'
  },
  // KYC
  kyc_pending_review: { fr: 'kyc-pending-review-fr', en: 'kyc-pending-review-en' },
  kyc_verified: { fr: 'kyc-verified-fr', en: 'kyc-verified-en' },
  kyc_rejected: { fr: 'kyc-rejected-fr', en: 'kyc-rejected-en' },
  // Paiement
  requestPaymentConfirmation: { fr: 'requestconfirmationpayment-en', en: 'requestconfirmationpayment-fr' },
  merchantPaymentReceived: { fr: 'merchant-payment-received-fr', en: 'merchant-payment-received-en' },
  // Rechargement
  refillAccount: { fr: 'refill-account-fr', en: 'refill-account-en' },
  // Confirmation wallet
  walletConfirmation: { fr: 'wallet-confirmation-fr', en: 'wallet-confirmation-en' },
  // OTP (généré localement)
  otpCode: { fr: 'otp-code-fr', en: 'otp-code-en' },
  // Wallet debit authorization OTP (generated locally; no approval link).
  walletDebitAuthorization: { fr: 'wallet-debit-authorization-fr', en: 'wallet-debit-authorization-en' },
};

export const emailService = {
  send: sendEmail,

  templates: TEMPLATES,

  /** Envoyer un email transactionnel via Resend avec template */
  async sendTemplate(
    templateKey: keyof typeof TEMPLATES,
    lang: 'fr' | 'en',
    to: string,
    variables: Record<string, string>
  ): Promise<boolean> {
    if (!RESEND_API_KEY) { console.error('[resend] RESEND_API_KEY is required'); return false; }
    const templateId = TEMPLATES[templateKey]?.[lang] || TEMPLATES[templateKey]?.en;
    if (!templateId) {
      console.error(`[resend] Template not found: ${templateKey}/${lang}`);
      return false;
    }

    // Vérifier si le templateId est un UUID (template Resend dashboard)
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(templateId);

    if (isUuid) {
      // Utiliser l'API template Resend (rendu côté Resend)
      const subjects: Record<string, Record<string, string>> = {
        confirmEmail: { fr: 'Confirmez votre adresse email', en: 'Confirm your email address' },
        welcome: { fr: 'Bienvenue sur Konektag !', en: 'Welcome to Konektag!' },
      };
      const subject = subjects[templateKey]?.[lang] || 'Konektag';
      try {
        const res = await fetch(RESEND_URL, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: FROM,
            to: [to],
            subject,
            template: { id: templateId, variables },
          }),
        });
        if (!res.ok) {
          await res.text();
          console.error('[resend] Template send failed');
          return false;
        }
        console.log('[resend] Template sent:', templateKey);
        return true;
      } catch (e: any) {
        console.error('[resend] Template send error');
        return false;
      }
    }

    // Fallback : construire le HTML localement
    const html = Object.entries(variables).reduce(
      (acc, [key, value]) => acc.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), value),
      `<!-- Template: ${templateId} -->`
    );

    return sendEmail({
      to,
      subject: templateKey === 'confirmEmail' ? 'Confirmez votre adresse email' :
               templateKey === 'welcome' ? 'Bienvenue sur Konektag !' :
               templateKey === 'kyc_verified' ? 'Votre identité a été vérifiée' :
               templateKey === 'kyc_rejected' ? 'Vérification d\'identité refusée' :
               templateKey === 'merchantPaymentReceived' ? 'Paiement reçu' :
               templateKey === 'requestPaymentConfirmation' ? 'Confirmation de paiement requise' :
               templateKey === 'refillAccount' ? 'Rechargement confirmé' :
                 templateKey === 'walletDebitAuthorization' ? 'Code d’autorisation Wallet' : 'Konektag',
      html: generateHtml(templateKey, lang, variables),
    });
  },
};

/** Génère un email HTML basé sur le template */
function generateHtml(
  templateKey: string,
  lang: 'fr' | 'en',
  vars: Record<string, string>
): string {
  const year = vars.currentYear || new Date().getFullYear().toString();
  
  const titles: Record<string, Record<string, string>> = {
    confirmEmail: { fr: 'Confirmez votre adresse email', en: 'Confirm your email address' },
    resetPassword: { fr: 'Réinitialisation de votre mot de passe', en: 'Reset your password' },
    otpCode: { fr: 'Votre code de vérification', en: 'Your verification code' },
    welcome: { fr: 'Bienvenue sur Konektag !', en: 'Welcome to Konektag!' },
    kyc_verified: { fr: 'Identité vérifiée', en: 'Identity verified' },
    kyc_rejected: { fr: 'Vérification refusée', en: 'Verification rejected' },
    merchantPaymentReceived: { fr: 'Paiement reçu', en: 'Payment received' },
    requestPaymentConfirmation: { fr: 'Confirmation de paiement', en: 'Payment confirmation required' },
    confirmPaymentDone: { fr: 'Paiement confirmé', en: 'Payment confirmed' },
    walletDebitAuthorization: { fr: 'Code d’autorisation Wallet', en: 'Wallet authorization code' },
    refillAccount: { fr: 'Rechargement confirmé', en: 'Account refilled' },
  };

  const title = titles[templateKey]?.[lang] || 'Konektag';
  const firstName = vars.firstName || '';

  let body = '';
  switch (templateKey) {
    case 'resetPassword':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Vous avez demandé une réinitialisation de votre mot de passe sur Konektag.</p><p>Cliquez sur le bouton ci-dessous pour choisir un nouveau mot de passe :</p><p><a href="${vars.resetUrl || '#'}" style="display:inline-block;padding:12px 24px;background:#D4A44A;color:#0B0F19;text-decoration:none;border-radius:6px;font-weight:700">Choisir un nouveau mot de passe</a></p><p>Si vous n'avez pas demandé cette réinitialisation, vous pouvez ignorer cet email.</p>`
        : `<p>Hello ${firstName},</p><p>You have requested a password reset on Konektag.</p><p>Click the button below to choose a new password:</p><p><a href="${vars.resetUrl || '#'}" style="display:inline-block;padding:12px 24px;background:#D4A44A;color:#0B0F19;text-decoration:none;border-radius:6px;font-weight:700">Choose a new password</a></p><p>If you did not request this reset, you can ignore this email.</p>`;
      break;
    case 'otpCode':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Voici votre code de vérification :</p><p style="text-align:center;font-size:36px;font-weight:700;letter-spacing:8px;color:#D4A44A;background:#0B0F19;padding:16px;border-radius:8px;margin:24px 0">${vars.code || '------'}</p><p>Ce code expire dans 5 minutes. Ne le partagez avec personne.</p>`
        : `<p>Hello ${firstName},</p><p>Here is your verification code:</p><p style="text-align:center;font-size:36px;font-weight:700;letter-spacing:8px;color:#D4A44A;background:#0B0F19;padding:16px;border-radius:8px;margin:24px 0">${vars.code || '------'}</p><p>This code expires in 5 minutes. Do not share it with anyone.</p>`;
      break;
    case 'walletDebitAuthorization':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Utilisez ce code pour autoriser le prélèvement Wallet de <strong>${vars.amount} ${vars.currency}</strong> vers <strong>${vars.payeeName}</strong> :</p><p style="text-align:center;font-size:36px;font-weight:700;letter-spacing:8px;color:#D4A44A;background:#0B0F19;padding:16px;border-radius:8px;margin:24px 0">${vars.code || '------'}</p><p>Ce code expire dans 5 minutes. Ne le partagez avec personne.</p>`
        : `<p>Hello ${firstName},</p><p>Use this code to authorize the Wallet debit of <strong>${vars.amount} ${vars.currency}</strong> to <strong>${vars.payeeName}</strong>:</p><p style="text-align:center;font-size:36px;font-weight:700;letter-spacing:8px;color:#D4A44A;background:#0B0F19;padding:16px;border-radius:8px;margin:24px 0">${vars.code || '------'}</p><p>This code expires in 5 minutes. Do not share it with anyone.</p>`;
      break;
    case 'welcome':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Bienvenue sur Konektag ! Votre compte est prêt. Vous pouvez maintenant envoyer de l'argent, payer par QR code et profiter de tous nos services.</p>`
        : `<p>Hello ${firstName},</p><p>Welcome to Konektag! Your account is ready. You can now send money, pay via QR code and enjoy all our services.</p>`;
      break;
    case 'kyc_verified':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Votre vérification d'identité a été acceptée. Vous avez désormais accès à l'ensemble de nos services.</p>`
        : `<p>Hello ${firstName},</p><p>Your identity verification has been approved. You now have access to all our services.</p>`;
      break;
    case 'kyc_rejected':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Votre vérification d'identité n'a pas pu aboutir. Motif : ${vars.reason || 'document illisible ou incomplet'}. Veuillez soumettre à nouveau vos documents depuis votre espace client.</p>`
        : `<p>Hello ${firstName},</p><p>Your identity verification could not be completed. Reason: ${vars.reason || 'unreadable or incomplete document'}. Please submit your documents again from your account.</p>`;
      break;
    case 'merchantPaymentReceived':
      body = lang === 'fr'
        ? `<p>Bonjour,</p><p>Vous avez reçu un paiement de <strong>${vars.amount || '0'} ${vars.currency || 'FCFA'}</strong>.</p><table><tr><td>Client</td><td>${vars.payer || ''}</td></tr><tr><td>Référence</td><td>${vars.reference || ''}</td></tr><tr><td>Date</td><td>${vars.date || ''}</td></tr></table>`
        : `<p>Hello,</p><p>You have received a payment of <strong>${vars.amount || '0'} ${vars.currency || 'FCFA'}</strong>.</p><table><tr><td>Client</td><td>${vars.payer || ''}</td></tr><tr><td>Reference</td><td>${vars.reference || ''}</td></tr><tr><td>Date</td><td>${vars.date || ''}</td></tr></table>`;
      break;
    case 'requestPaymentConfirmation':
      body = lang === 'fr'
        ? `<p>Bonjour ${firstName},</p><p>Une demande de paiement de <strong>${vars.amount} ${vars.currency}</strong> a été initiée par <strong>${vars.merchantName}</strong>.</p><table style="width:100%;border-collapse:collapse"><tr><td>Montant</td><td>${vars.amount} ${vars.currency}</td></tr><tr><td>Frais</td><td>${vars.fees} ${vars.currency}</td></tr><tr><td>Total</td><td><strong>${vars.totalAmount} ${vars.currency}</strong></td></tr><tr><td>Référence</td><td>${vars.transactionReference}</td></tr><tr><td>Date</td><td>${vars.transactionDate}</td></tr></table><p><a href="${vars.confirmationUrl || '#'}">Confirmer le paiement</a></p>`
        : `<p>Hello ${firstName},</p><p>A payment request of <strong>${vars.amount} ${vars.currency}</strong> has been initiated by <strong>${vars.merchantName}</strong>.</p><table style="width:100%;border-collapse:collapse"><tr><td>Amount</td><td>${vars.amount} ${vars.currency}</td></tr><tr><td>Fees</td><td>${vars.fees} ${vars.currency}</td></tr><tr><td>Total</td><td><strong>${vars.totalAmount} ${vars.currency}</strong></td></tr><tr><td>Reference</td><td>${vars.transactionReference}</td></tr><tr><td>Date</td><td>${vars.transactionDate}</td></tr></table><p><a href="${vars.confirmationUrl || '#'}">Confirm payment</a></p>`;
      break;
      break;
  }

  const footer = lang === 'fr'
    ? `© ${year} Konektag. Tous droits réservés.`
    : `© ${year} Konektag. All rights reserved.`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:Arial,sans-serif;background:#0B0F19;color:#E5E7EB;padding:20px"><div style="max-width:600px;margin:0 auto;background:#1A1F2E;border-radius:12px;padding:24px;border:1px solid #2A2F3E"><div style="text-align:center;margin-bottom:20px"><h1 style="color:#D4A44A;margin:0">Konektag</h1></div><h2 style="color:#D4A44A">${title}</h2>${body}<hr style="border-color:#2A2F3E;margin-top:20px"><p style="font-size:12px;color:#6B7280">${footer}</p></div></body></html>`;
}

