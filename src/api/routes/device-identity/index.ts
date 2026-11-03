import type { RouteHandler } from '../../http';
import { z } from 'zod';
import { identityBootstrap, enrollIdentity, revokeDevice } from '../../../application/core02-identity-service.ts';
const result = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const command = z.discriminatedUnion('action', [z.object({ action: z.literal('certify'), proof: z.string().max(4096) }).strict(), z.object({ action: z.literal('revoke'), deviceId: z.string().uuid(), keyId: z.string().uuid().optional() }).strict()]);
const clientErrors = new Set([
    'PROOF_INVALID', 'OWNER_MISMATCH', 'OWNER_UNKNOWN', 'DEVICE_DENIED',
    'KEY_CONFLICT', 'VERSION_CONFLICT', 'KEY_EXPIRED', 'DEVICE_CONFLICT',
    'DEVICE_ALREADY_ACTIVE', 'KEY_UNKNOWN', 'MERCHANT_ACCESS_DENIED',
    'INVALID_BASE64URL', 'NONCANONICAL_BASE64URL', 'INVALID_KEY', 'INVALID_HEADER',
    'Invalid value for canonical JSON', 'Token exceeds maximum length',
    'Malformed JWS token', 'Invalid signature length', 'Header contains unexpected fields',
    'Header fields mismatch', 'Header is not canonical', 'Payload is not canonical',
    'Invalid signature', 'issuedAt and expiresAt must be numbers',
    'Time is in the future relative to issuedAt', 'Time is past the expiration window',
]);
const failure = (error: unknown) => {
    console.error('[device-identity]', error instanceof Error ? { message: error.message, name: error.name } : error);
    if (error instanceof Error && error.message === 'AUTHORITY_UNAVAILABLE')
        return result({ error: 'AUTHORITY_UNAVAILABLE' }, 503);
    if (error instanceof Error && ['REVOCATION_CAPACITY', 'POLICY_INVALID'].includes(error.message))
        return result({ error: 'DEVICE_IDENTITY_UNAVAILABLE' }, 503);
    const invalidInput = error instanceof z.ZodError || error instanceof SyntaxError ||
        (error instanceof Error && clientErrors.has(error.message)) ||
        (error instanceof DOMException && ['DataError', 'OperationError'].includes(error.name)) ||
        (error instanceof TypeError && (error as NodeJS.ErrnoException).code === 'ERR_ENCODING_INVALID_ENCODED_DATA');
    const safeCode = error instanceof Error && clientErrors.has(error.message) ? error.message : undefined;
    return invalidInput
        ? result({ error: 'DEVICE_IDENTITY_REJECTED', ...(safeCode ? { code: safeCode } : {}) }, 400)
        : result({ error: 'DEVICE_IDENTITY_UNAVAILABLE' }, 500);
};
export const GET: RouteHandler = async ({ locals, url }) => { if (!locals.user)
    return result({ error: 'UNAUTHORIZED' }, 401); try {
    const key = url.searchParams.get('keyId');
    return result(await identityBootstrap(locals.user.id, key === null ? undefined : z.string().uuid().parse(key)));
}
catch (error) {
    return failure(error);
} };
function effectiveOrigin(request: Request, url: URL) {
    const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
    const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim() || request.headers.get('host');
    return proto && host ? `${proto}://${host}` : url.origin;
}
export const POST: RouteHandler = async ({ locals, request, url }) => {
    if (!locals.user)
        return result({ error: 'UNAUTHORIZED' }, 401);
    const origin = request.headers.get('origin');
    const expectedOrigin = effectiveOrigin(request, url);
    if (!origin || origin !== expectedOrigin) {
        console.warn('[device-identity] origin denied', { origin, expectedOrigin });
        return result({ error: 'ORIGIN_DENIED' }, 403);
    }
    if (!request.headers.get('content-type')?.startsWith('application/json'))
        return result({ error: 'CONTENT_TYPE' }, 415);
    try {
        const length = Number(request.headers.get('content-length') || 0);
        if (length > 6000)
            return result({ error: 'BODY_TOO_LARGE' }, 413);
        const reader = request.body?.getReader();
        if (!reader)
            return result({ error: 'BODY_REQUIRED' }, 400);
        let bytes = 0, body = '';
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > 6000) {
                await reader.cancel();
                return result({ error: 'BODY_TOO_LARGE' }, 413);
            }
            body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
        const input = command.parse(JSON.parse(body));
        return result(input.action === 'certify' ? await enrollIdentity(locals.user.id, input.proof) : await revokeDevice(locals.user.id, input.deviceId, input.keyId));
    }
    catch (error) {
        return failure(error);
    }
};
