import { describe, expect, it } from 'vitest';
import { GET, POST } from '../../src/api/routes/cash-agent/index.ts';

describe('P05 cash agent', () => {
  it('cannot be enabled through its public route', async () => {
    expect((await GET({} as any)).status).toBe(410);
    expect((await POST({} as any)).status).toBe(410);
  });
});
