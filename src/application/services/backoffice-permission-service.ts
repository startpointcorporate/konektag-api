import type { PoolClient } from 'pg';
import pool from '../../infrastructure/database/pool.ts';

export type BackofficeRole =
  | 'admin'
  | 'support'
  | 'operations'
  | 'compliance'
  | 'finance_local'
  | 'finance_groupe'
  | 'approver'
  | 'admin_technique';

export type BackofficePermission =
  | 'kyc:read'
  | 'kyc:write'
  | 'users:read'
  | 'users:write'
  | 'recharges:read'
  | 'recharges:write'
  | 'merchants:read'
  | 'merchants:write'
  | 'finance:read'
  | 'finance:write'
  | 'clearing:read'
  | 'clearing:write'
  | 'settlements:read'
  | 'settlements:write'
  | 'sales:read'
  | 'interco:read'
  | 'klots:read'
  | 'klots:write'
  | 'cards:read'
  | 'cards:write'
  | 'campaigns:read'
  | 'campaigns:write'
  | 'compliance:read'
  | 'compliance:write'
  | 'dashboard:read';

const ROLE_PERMISSIONS: Record<BackofficeRole, BackofficePermission[]> = {
  admin: ['kyc:read', 'kyc:write', 'users:read', 'users:write', 'recharges:read', 'recharges:write', 'merchants:read', 'merchants:write', 'finance:read', 'finance:write', 'clearing:read', 'clearing:write', 'settlements:read', 'settlements:write', 'sales:read', 'interco:read', 'klots:read', 'klots:write', 'cards:read', 'cards:write', 'campaigns:read', 'campaigns:write', 'compliance:read', 'compliance:write', 'dashboard:read'],
  support: ['kyc:read', 'users:read', 'recharges:read', 'merchants:read', 'cards:read', 'dashboard:read'],
  operations: ['kyc:read', 'users:read', 'recharges:read', 'recharges:write', 'merchants:read', 'cards:read', 'cards:write', 'campaigns:read', 'dashboard:read'],
  compliance: ['kyc:read', 'kyc:write', 'users:read', 'merchants:read', 'compliance:read', 'compliance:write', 'dashboard:read'],
  finance_local: ['finance:read', 'settlements:read', 'settlements:write', 'sales:read', 'interco:read', 'klots:read', 'recharges:read', 'dashboard:read'],
  finance_groupe: ['finance:read', 'finance:write', 'settlements:read', 'clearing:read', 'clearing:write', 'sales:read', 'interco:read', 'klots:read', 'klots:write', 'recharges:read', 'dashboard:read'],
  approver: ['kyc:write', 'settlements:write', 'clearing:write', 'recharges:write', 'cards:write', 'compliance:write'],
  admin_technique: ['users:read', 'users:write', 'merchants:read', 'cards:read', 'cards:write', 'campaigns:read', 'dashboard:read'],
};

export interface AuthUser {
  id: string;
  keycloak_id: string;
  username: string;
  email?: string;
  locale: string;
  state: string;
  role: BackofficeRole;
  country?: string;
  legal_entity_id?: string;
  legal_entity_code?: string;
}

export function requireBackofficePermission(
  permission: BackofficePermission,
  legalEntityScope?: string,
): (locals: any) => Promise<{ authorized: boolean; user: AuthUser | null; reason?: string }> {
  return async (locals: any) => {
    const user = locals.user;
    if (!user) return { authorized: false, user: null, reason: 'UNAUTHORIZED' };

    const { rows: [dbUser] } = await pool.query(
      `SELECT role FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
      [user.id],
    );

    if (!dbUser) return { authorized: false, user: null, reason: 'USER_NOT_FOUND' };

    const role = dbUser.role as BackofficeRole;
    const permissions = ROLE_PERMISSIONS[role] || [];

    if (!permissions.includes(permission)) {
      return { authorized: false, user: { ...user, role }, reason: `Missing permission: ${permission}` };
    }

    if (legalEntityScope) {
      // The requested legal entity scopes the financial DATA being accessed; it
      // must not be inferred from the operator's country of residence.
      // Global back-office roles can work across entities. Local finance remains
      // constrained to an explicitly assigned legal_entity_code.
      const globalEntityRoles: BackofficeRole[] = ['admin', 'finance_groupe'];
      if (!globalEntityRoles.includes(role)) {
        if (!user.legal_entity_code) {
          return {
            authorized: false,
            user: { ...user, role },
            reason: 'Entity scope assignment required',
          };
        }
        if (user.legal_entity_code !== legalEntityScope) {
          return {
            authorized: false,
            user: { ...user, role },
            reason: `Entity scope mismatch: required ${legalEntityScope}`,
          };
        }
      }
    }

    return { authorized: true, user: { ...user, role } };
  };
}

export function forbiddenResponse(reason?: string): Response {
  return new Response(JSON.stringify({
    error: 'FORBIDDEN',
    reason: reason || 'Insufficient permissions',
  }), { status: 403, headers: { 'Content-Type': 'application/json' } });
}

export function isAdmin(user: any): boolean {
  return user?.role === 'admin' || user?.role === 'admin_technique';
}
