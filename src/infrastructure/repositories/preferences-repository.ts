import type { PoolClient } from 'pg';

export class PreferencesRepository {
  constructor(private client: PoolClient) {}

  async findByUserId(userId: string): Promise<{ selected_features: string[] } | null> {
    const { rows } = await this.client.query(
      `SELECT selected_features FROM konektag.user_preferences
       WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    return rows[0] ?? null;
  }

  async upsert(userId: string, features: string[]): Promise<void> {
    await this.client.query(
      `INSERT INTO konektag.user_preferences (user_id, selected_features)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET selected_features = EXCLUDED.selected_features, updated_at = now()`,
      [userId, JSON.stringify(features)],
    );
  }
}
