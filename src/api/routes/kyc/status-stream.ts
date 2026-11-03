import type { RouteHandler } from '../../http';
import { redisAdapter } from '../../../infrastructure/adapters/redis-adapter.ts';
import pool from '../../../infrastructure/database/pool.ts';
import { OnboardingStateMachine, type OnboardingState } from '../../../domain/OnboardingStateMachine.ts';

export const GET: RouteHandler = async ({ locals }) => {
  const user = locals.user;
  if (!user) return new Response(null, { status: 401 });

  let cleanup: (() => Promise<void>) | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      // 1. Envoie l'état actuel depuis PostgreSQL
      const { rows: [current] } = await pool.query(
        `SELECT state FROM konektag.users WHERE id = $1 AND deleted_at IS NULL`,
        [user.id],
      );

      if (current) {
        const kycStatus = OnboardingStateMachine.projectKycStatus(current.state as OnboardingState);
        controller.enqueue(
          `event: status_update\ndata: ${JSON.stringify({ status: kycStatus, state: current.state, timestamp: new Date().toISOString() })}\n\n`,
        );
      }

      // 2. Souscrit à Redis Pub/Sub
      try {
        const sub = await redisAdapter.subscribeKycStatus(user.id);
        cleanup = sub.unsubscribe;

        for await (const event of sub) {
          controller.enqueue(
            `event: status_update\ndata: ${JSON.stringify(event)}\n\n`,
          );
        }
      } catch (err) {
        // Redis might be down, just close the stream
        controller.close();
      }
    },
    cancel() {
      cleanup?.();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
};
