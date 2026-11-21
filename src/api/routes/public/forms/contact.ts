import type { RequestContext } from '../../../http.ts';
import { submitContact } from '../../../../application/public-forms/contact.ts';
import { defaultFormDeps, handleForm, type FormHttpDeps } from '../../../../application/public-forms/http.ts';

/** Contact form of an authorised site: Lead + Communication, or Issue for support. */
export const POST = (ctx: RequestContext, deps?: FormHttpDeps): Promise<Response> => handleForm(ctx, async body => {
  const result = await submitContact(body, {
    origin: ctx.request.headers.get('origin'),
    clientAddress: ctx.clientAddress,
    idempotencyKey: ctx.request.headers.get('idempotency-key'),
  }, deps ?? defaultFormDeps());
  return { status: result.replayed ? 200 : 201, body: { reference: result.reference, replayed: result.replayed } };
});
