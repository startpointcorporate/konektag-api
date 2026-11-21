import type { RequestContext } from '../../../../http.ts';
import { confirmOptin } from '../../../../../application/public-forms/optin.ts';
import { defaultFormDeps, handleForm, type FormHttpDeps } from '../../../../../application/public-forms/http.ts';

/** Single-use confirmation link of the double opt-in. */
export const POST = (ctx: RequestContext, deps?: FormHttpDeps): Promise<Response> => handleForm(ctx, async body => {
  const result = await confirmOptin(body, { clientAddress: ctx.clientAddress }, deps ?? defaultFormDeps());
  return { status: 200, body: { status: 'SUBSCRIBED', list: result.list, unsubscribeToken: result.unsubscribeToken } };
});
