import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { query: mocks.query, connect: mocks.connect },
}));

import { ambassadorRepository } from '../../src/infrastructure/repositories/ambassador-repository.ts';
import { ambassadorService } from '../../src/application/services/ambassador-service.ts';
import { agentService } from '../../src/application/services/agent-service.ts';

describe('ambassador persistence contracts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.query.mockReset();
    mocks.connect.mockReset();
  });

  it('only accepts an agent application for a merchant owned by the authenticated user', async () => {
    mocks.query
      .mockResolvedValueOnce({ rows: [{ id: 'merchant-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'application-1' }] });

    await ambassadorRepository.createAgentApplication('user-1', {
      merchant_profile_id: 'merchant-1', business_name: 'Shop', manager_name: 'Owner',
      phone: '1', email: 'owner@example.test', country: 'CG', city: 'BZV',
      full_address: '', activity_type: 'Commerce', terms_accepted: true,
    });

    const [ownershipSql, ownershipParams] = mocks.query.mock.calls[0];
    expect(ownershipSql).toContain('(mp.user_id = $1 OR mm.user_id IS NOT NULL)');
    expect(ownershipSql).toContain("mm.role IN ('owner', 'manager')");
    expect(ownershipSql).toContain('AND mp.id = $2');
    expect(ownershipParams).toEqual(['user-1', 'merchant-1']);
    expect(mocks.query.mock.calls[1][1][0]).toBe('user-1');
  });

  it('does not expose evidence while listing available missions', async () => {
    mocks.query.mockResolvedValue({ rows: [] });
    await ambassadorRepository.listAvailableMissions({});

    const sql = mocks.query.mock.calls[0][0];
    expect(sql).toContain("'[]'::json AS evidence");
    expect(sql).toContain("m.status = 'Reserved' AND m.reservation_expires_at <= now()");
    expect(sql).toContain("'Available'::text AS status");
    expect(sql).not.toContain('JOIN konektag.mission_evidence');
  });

  it('atomically reclaims an expired reservation without counting it against the limit', async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id, max_active_missions')) return { rows: [{ id: 'rep-1', max_active_missions: 3 }] };
      if (sql.includes('SELECT count(*)')) return { rows: [{ value: 0 }] };
      if (sql.includes('UPDATE konektag.field_missions')) return { rows: [{ id: 'mission-1' }] };
      return { rows: [] };
    });
    mocks.connect.mockResolvedValue({ query: clientQuery, release: vi.fn() });
    mocks.query.mockResolvedValue({ rows: [{ id: 'mission-1', name: 'mission-1', evidence: [] }] });

    await ambassadorRepository.reserveMission('mission-1', 'user-1');

    const countSql = clientQuery.mock.calls.find(([sql]) => sql.includes('SELECT count(*)'))![0];
    const reserveSql = clientQuery.mock.calls.find(([sql]) => sql.includes('UPDATE konektag.field_missions'))![0];
    expect(countSql).toContain('reservation_expires_at > now()');
    expect(reserveSql).toContain("status = 'Reserved' AND reservation_expires_at <= now()");
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects empty evidence before opening a transaction', async () => {
    await expect(ambassadorRepository.submitMission('mission-1', 'user-1', {
      evidence: [{ evidence_type: 'Photo', file_url: ' ', comment: '' }],
    })).rejects.toThrow('INVALID_EVIDENCE');
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it('returns numeric, type-scoped representative commission DTOs', async () => {
    const list = vi.spyOn(ambassadorRepository, 'listCommissions').mockResolvedValue([{
      name: 'commission-1', commission_type: 'RepresentativeMission', status: 'Valide',
      ambassadeur: 'rep-1', mission: 'mission-1', withdrawal: null,
      gross_amount: '1250.50', commission_rate: '0', commission_amount: '1250.50', currency: 'XOF',
    }]);

    const result = await ambassadorService.getCommissions('user-1');

    expect(list).toHaveBeenCalledWith('user-1', undefined, 'RepresentativeMission');
    expect(result[0]).toMatchObject({ gross_amount: 1250.5, commission_rate: 0, commission_amount: 1250.5 });
  });

  it('type-scopes agent commissions and preserves a zero commission rate', async () => {
    vi.spyOn(ambassadorRepository, 'getOwnedAgent').mockResolvedValue({ id: 'agent-1' });
    const list = vi.spyOn(ambassadorRepository, 'listCommissions').mockResolvedValue([{
      name: 'commission-1', commission_type: 'AgentWithdrawal', status: 'Valide',
      ambassador: 'agent-1', withdrawal: 'withdrawal-1', gross_amount: '100',
      commission_rate: '0', commission_amount: '0', currency: 'XOF',
    }]);

    const result = await agentService.getAgentCommissions('user-1', 'agent-1');

    expect(list).toHaveBeenCalledWith('user-1', 'agent-1', 'AgentWithdrawal');
    expect(result[0]).toMatchObject({ gross_amount: 100, commission_rate: 0, commission_amount: 0 });
  });
});
