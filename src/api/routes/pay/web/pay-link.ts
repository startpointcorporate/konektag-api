import { createPayLinkHandler } from '../pay-link.ts';

/** Astro Points K entry point: Boost links are rejected from server-owned data. */
export const POST = createPayLinkHandler({ allowBoost: false, routeKey: 'WEB_LINK_PAYMENT' });
