/** HTTP adapter of the public forms: default dependencies and the error envelope. */
import type { RequestContext } from '../../api/http.ts';
import { redisAdapter } from '../../infrastructure/adapters/redis-adapter.ts';
import { emailService } from '../services/resend-service.ts';
import { FormError, readJson, reply, type FormStore } from './guards.ts';
import { konektagPublicFormSites, PublicFormSiteError, type PublicFormSites } from './site.ts';

export type FormHttpDeps = {
  sites: PublicFormSites;
  store: FormStore;
  sendEmail: (mail: { to: string; subject: string; html: string; idempotencyKey?: string }) => Promise<boolean>;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

export function defaultFormDeps(): FormHttpDeps {
  return { sites: konektagPublicFormSites(), store: redisAdapter, sendEmail: mail => emailService.send(mail) };
}

/** Runs a form operation and maps every expected failure to `{ ok: false, error }`. */
export async function handleForm(
  ctx: RequestContext,
  run: (body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<Response> {
  try {
    const body = await readJson(ctx.request);
    const result = await run(body);
    return reply({ ok: true, ...result.body }, result.status);
  } catch (error) {
    if (error instanceof FormError || error instanceof PublicFormSiteError) {
      const headers: Record<string, string> = error.status === 429 ? { 'Retry-After': '3600' } : {};
      return Response.json({ ok: false, error: error.code }, { status: error.status, headers: { 'Cache-Control': 'no-store', ...headers } });
    }
    console.error('[public-forms] unexpected failure', error instanceof Error ? error.name : 'Error');
    return reply({ ok: false, error: 'SERVICE_UNAVAILABLE' }, 503);
  }
}
