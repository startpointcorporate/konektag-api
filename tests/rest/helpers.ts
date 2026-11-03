import { createContext } from '../../src/api/http';
export function context(path: string, body?: unknown, signedIn = true) {
  const c = createContext(new Request(`https://api.invalid${path}`, { method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  if (signedIn) c.locals.user = { id: 'session-user', keycloak_id: 'kc-owner' };
  return c;
}
