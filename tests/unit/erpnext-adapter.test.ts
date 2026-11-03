import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('ERPNext adapter', () => {
  it('uses the Frappe API token for resource requests without a session login', async () => {
    process.env.ERPNEXT_URL = 'https://erp.example.test';
    process.env.FRAPPE_API_KEY = 'test-key';
    process.env.FRAPPE_API_SECRET = 'test-secret';
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ name: 'KTG-FR' }] }), { status: 200 }),
    );

    const { erpnext } = await import('../../src/infrastructure/adapters/erpnext-adapter.ts');
    await expect(erpnext.list('Konektag Legal Entity', { status: 'Approved' }, ['name'], 1)).resolves.toEqual([{ name: 'KTG-FR' }]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/resource/Konektag%20Legal%20Entity?'),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'token test-key:test-secret',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('requires both Frappe API token variables', async () => {
    process.env.ERPNEXT_URL = 'https://erp.example.test';
    delete process.env.FRAPPE_API_KEY;
    delete process.env.FRAPPE_API_SECRET;

    await expect(import('../../src/infrastructure/adapters/erpnext-adapter.ts')).rejects.toThrow('FRAPPE_API_KEY environment variable is required');
  });
});
