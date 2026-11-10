import { describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn() }));
vi.mock('../../src/infrastructure/database/pool.ts', () => ({
  default: { connect: async () => ({ query: m.query, release: m.release }), query: m.query },
}));

import { frappeMasterDataProjectionService } from '../../src/application/services/frappe-master-data-projection-service.ts';

describe('master data projection source', () => {
  it('reads the legal entity on the given Konektag site and maps a Frappe country name to ISO', async () => {
    m.query.mockImplementation(async (sql: string) => String(sql).includes('count(*)') ? { rows: [{ count: 1 }] } : { rows: [{ id: 'le-lb' }] });
    const source = { get: vi.fn(async () => ({ entity_code: 'KTG-LB', entity_name: 'Konektag Lebanon', company: 'konektag lebanon', country: 'Lebanon', currency: 'USD', status: 'Approved', modified: '2026-11-10' })) };
    await expect(frappeMasterDataProjectionService.projectLegalEntity('KTG-LB', source)).resolves.toMatchObject({ code: 'KTG-LB', status: 'APPROVED' });
    expect(source.get).toHaveBeenCalledWith('Konektag Legal Entity', 'KTG-LB');
    const insert = m.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO konektag.legal_entities'))!;
    expect(insert[1]).toEqual(['KTG-LB', 'Konektag Lebanon', 'LB', 'USD', 'konektag lebanon', 'APPROVED']);
  });
});
