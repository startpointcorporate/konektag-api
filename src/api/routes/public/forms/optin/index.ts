import type { RequestContext } from '../../../../http.ts';
import { requestOptin } from '../../../../../application/public-forms/optin.ts';
import { defaultFormDeps, handleForm, type FormHttpDeps } from '../../../../../application/public-forms/http.ts';

/** Explicit marketing consent; sends the double opt-in confirmation e-mail. */
export const POST = (ctx: RequestContext, deps?: FormHttpDeps): Promise<Response> => handleForm(ctx, async body => {
  await requestOptin(body, { origin: ctx.request.headers.get('origin'), clientAddress: ctx.clientAddress }, deps ?? defaultFormDeps());
  return { status: 202, body: { status: 'CONFIRMATION_SENT' } };
});
