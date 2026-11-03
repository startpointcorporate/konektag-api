import type { RouteHandler } from '../../http';
import { emailService } from '../../../application/services/resend-service.ts';

export const POST: RouteHandler = async ({ request }) => {
  try {
    const body = await request.json();
    const { nom, prenom, email, pinCode } = body;

    if (!nom || !prenom || !email || !pinCode) {
      return new Response(JSON.stringify({ error: 'Tous les champs sont requis' }), { status: 400 });
    }

    const siteUrl = process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321';

    const ok = await emailService.sendTemplate(
      'confirmEmail',
      'en',
      email,
      {
        currentYear: new Date().getFullYear().toString(),
        firstName: prenom,
        PINCODE: pinCode,
        verificationUrl: siteUrl,
      }
    );

    if (!ok) {
      return new Response(JSON.stringify({ error: "Échec de l'envoi de l'email" }), { status: 500 });
    }

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
};
