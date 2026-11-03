import type { PoolClient } from 'pg';

export class ConfigurationRepository {
  constructor(private client: PoolClient) {}

  async get(key: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.client.query(
      `SELECT value FROM konektag.configurations WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async getNumeric(key: string, path: string, fallback: number): Promise<number> {
    const config = await this.get(key);
    if (!config) return fallback;
    const value = path.split('.').reduce((obj, k) => obj?.[k] as any, config);
    return typeof value === 'number' ? value : fallback;
  }
}
