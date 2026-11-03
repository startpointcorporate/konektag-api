import { keycloakAdapter } from '../../infrastructure/adapters/keycloak-adapter.ts';
import pool from '../../infrastructure/database/pool.ts';

export class AuthService {
  async exchangeCode(code: string, codeVerifier: string, redirectUri: string) {
    return keycloakAdapter.exchangeCode(code, codeVerifier, redirectUri);
  }

  async refreshToken(refreshToken: string) {
    return keycloakAdapter.refreshToken(refreshToken);
  }

  async validateToken(accessToken: string) {
    return keycloakAdapter.validateToken(accessToken);
  }

  async getUserByKeycloakId(keycloakId: string) {
    const { rows } = await pool.query(
      `SELECT * FROM konektag.users WHERE keycloak_id = $1 AND deleted_at IS NULL`,
      [keycloakId],
    );
    return rows[0] ?? null;
  }
  
  async getUserWithAttributes(keycloakId: string) {
    // Get the user from database
    const dbUser = await this.getUserByKeycloakId(keycloakId);
    if (!dbUser) return null;

    try {
      // Get user details including attributes from Keycloak
      const keycloakUser = await keycloakAdapter.getUser(keycloakId);

      if (!keycloakUser) {
        console.error(`Failed to fetch Keycloak user attributes for ${keycloakId}`);
        return dbUser;
      }
      
      // Extract first/last name from attributes
      const firstName = keycloakUser.attributes?.firstName?.[0] || '';
      const lastName = keycloakUser.attributes?.lastName?.[0] || '';
      
      return {
        ...dbUser,
        firstName,
        lastName,
        email: keycloakUser.email
      };
    } catch (error) {
      console.error('Error fetching Keycloak user attributes:', error);
      // Return database user if we can't fetch from Keycloak
      return dbUser;
    }
  }

  async updateUserProfile(keycloakId: string, profileData: Record<string, unknown>) {
    const client = await pool.connect();
    const has = (key: string) => Object.prototype.hasOwnProperty.call(profileData, key);
    const optionalString = (key: string): string | null | undefined => {
      if (!has(key)) return undefined;
      const value = profileData[key];
      if (value == null) return null;
      return typeof value === 'string' ? value.trim() || null : undefined;
    };

    try {
      await client.query('BEGIN');

      // First/last name live in Keycloak. Omitted values remain unchanged; an explicit
      // empty value clears the optional attribute.
      if (has('firstName') || has('lastName')) {
        const keycloakAttributes: Record<string, string> = {};
        if (has('firstName')) keycloakAttributes.firstName = String(profileData.firstName ?? '').trim();
        if (has('lastName')) keycloakAttributes.lastName = String(profileData.lastName ?? '').trim();
        await keycloakAdapter.updateUserAttributes(keycloakId, keycloakAttributes);
      }

      const columnByField: Record<string, string> = {
        displayName: 'display_name',
        birthDate: 'birth_date',
        address: 'address',
        city: 'city',
        country: 'country',
        phoneNumber: 'phone_number',
        kSendHistoryEmail: 'k_send_history_email',
        paymentOtpEmail: 'payment_otp_email',
      };

      const updateFields: string[] = [];
      const values: Array<string | null> = [];
      let paramIndex = 1;

      for (const [field, column] of Object.entries(columnByField)) {
        const value = optionalString(field);
        if (value === undefined) continue;
        updateFields.push(`${column} = $${paramIndex++}`);
        values.push(value);
      }

      if (updateFields.length > 0) {
        const query = `UPDATE konektag.users SET ${updateFields.join(', ')} WHERE keycloak_id = $${paramIndex} AND deleted_at IS NULL`;
        values.push(keycloakId);
        await client.query(query, values);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }}

export const authService = new AuthService();
