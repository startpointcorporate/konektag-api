import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('retention outbox cleanup', () => {
  it('uses the outbox completion timestamps instead of a nonexistent status column', () => {
    const source = readFileSync(new URL('../../src/infrastructure/scripts/jobs/purge-expired-data.ts', import.meta.url), 'utf8');
    expect(source).toContain('processed_at IS NOT NULL OR dead_lettered_at IS NOT NULL');
    expect(source).not.toContain("outbox_events WHERE status IN");
  });
});
