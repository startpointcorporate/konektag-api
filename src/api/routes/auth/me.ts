import type { RouteHandler } from '../../http';
import { keycloakAdapter } from '../../../infrastructure/adapters/keycloak-adapter.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { authService } from '../../../application/services/auth-service.ts';
import { encryptionService } from '../../../infrastructure/adapters/encryption-service.ts';

interface UserProfileResponse {
  firstName: string;
  lastName: string;
  displayName: string | null;
  username: string | null;
  email: string | null;
  birthDate: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  phoneNumber: string | null;
  kSendHistoryEmail: string | null;
  paymentOtpEmail: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
  locale: string | null;
  profileType: string | null;
}

const optionalStringFields = [
  'displayName', 'birthDate', 'address', 'city', 'country', 'phoneNumber',
  'kSendHistoryEmail', 'paymentOtpEmail',
] as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const { rows } = await pool.query(
      `SELECT
        u.username,
        u.locale,
        u.email_verified,
        u.phone_verified,
        u.display_name,
        u.birth_date,
        u.address,
        u.city,
        u.country,
        u.phone_number,
        u.k_send_history_email,
        u.payment_otp_email,
        u.profile_type,
        u.encrypted_data
       FROM konektag.users u
       WHERE u.keycloak_id = $1 AND u.deleted_at IS NULL`,
      [user.keycloak_id],
    );

    if (rows.length === 0) return json({ error: 'User not found' }, 404);

    const db = rows[0];
    const keycloakUser = await keycloakAdapter.getUser(user.keycloak_id);
    if (!keycloakUser) console.error(`Failed to fetch Keycloak user attributes for ${user.keycloak_id}`);

    let pii: Record<string, unknown> = {};
    try {
      if (db.encrypted_data) pii = JSON.parse(encryptionService.decrypt(db.encrypted_data));
    } catch {
      console.error('Unable to decrypt user profile data');
    }
    const kc = keycloakUser as any;
    const response: UserProfileResponse = {
      firstName: kc?.firstName || kc?.attributes?.firstName?.[0] || String(pii.firstName ?? ''),
      lastName: kc?.lastName || kc?.attributes?.lastName?.[0] || String(pii.lastName ?? ''),
      displayName: db.display_name ?? null,
      username: db.username ?? null,
      email: keycloakUser?.email ?? null,
      birthDate: db.birth_date ? String(db.birth_date).slice(0, 10) : (pii.birthDate ? String(pii.birthDate).slice(0, 10) : null),
      address: db.address ?? null,
      city: db.city ?? null,
      country: db.country ?? null,
      phoneNumber: db.phone_number ?? null,
      kSendHistoryEmail: db.k_send_history_email ?? null,
      paymentOtpEmail: db.payment_otp_email ?? null,
      emailVerified: db.email_verified === true,
      phoneVerified: db.phone_verified === true,
      locale: db.locale ?? null,
      profileType: db.profile_type ?? null,
    };

    return json(response);
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return json({ error: 'Internal Server Error' }, 500);
  }
};

export const PUT: RouteHandler = async ({ locals, request }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  try {
    const profileData = await request.json() as Record<string, unknown>;

    for (const field of ['firstName', 'lastName'] as const) {
      if (!(field in profileData)) continue;
      if (typeof profileData[field] !== 'string') return json({ error: `${field} must be a string` }, 400);
    }

    for (const field of optionalStringFields) {
      if (!(field in profileData)) continue;
      const value = profileData[field];
      if (value !== null && typeof value !== 'string') return json({ error: `${field} must be a string or null` }, 400);
    }

    await authService.updateUserProfile(user.keycloak_id, profileData);
    return json({ message: 'Profile updated successfully' });
  } catch (error) {
    console.error('Error updating profile:', error);
    return json({ error: 'Failed to update profile' }, 500);
  }
};
