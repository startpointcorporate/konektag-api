import type { RequestContext } from '../../../../http.ts';
import { unsubscribe } from '../../../../../application/public-forms/optin.ts';
import { defaultFormDeps, handleForm, type FormHttpDeps } from '../../../../../application/public-forms/http.ts';

/** Withdrawal of consent with the signed unsubscribe token (POST only: link scanners cannot unsubscribe). */
export const POST = (ctx: RequestContext, deps?: FormHttpDeps): Promise<Response> => handleForm(ctx, async body => {
  await unsubscribe(body, { clientAddress: ctx.clientAddress }, deps ?? defaultFormDeps());
  return { status: 200, body: { status: 'UNSUBSCRIBED' } };
});
