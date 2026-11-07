#!/usr/bin/env node
// First DESIGN acceptance run for Restaurant (#25 / #50). Never against production.
//
// 1. Opens the published profile on the Web (DESIGN) and reads a dish exactly
//    as the visitor sees it (item code and displayed price).
// 2. Places an order through the Web relay, then replays the same submission
//    with the same Idempotency-Key.
// 3. Reads Lumen with the service account (read only) and checks that exactly
//    one POS Restaurant Order carries the key and that its name is the
//    reference shown to the visitor.
//
// Env: RECETTE_WEB_ORIGIN (e.g. https://design.konektag.eu), RECETTE_SLUG,
//      MARKETPLACE_FRAPPE_RESTODEMO_URL / _API_KEY / _API_SECRET,
//      RECETTE_POS_PROFILE, RECETTE_CHANNEL (default Konektag),
//      RECETTE_PHONE (fictional, default +242060000000).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const need = name => { const v = process.env[name]; if (!v) { console.error(`Missing ${name}`); process.exit(2); } return v; };
const web = new URL(need('RECETTE_WEB_ORIGIN'));
if (web.hostname === 'www.konektag.eu' || web.hostname === 'konektag.eu') { console.error('Refusing to run against production'); process.exit(2); }
const slug = need('RECETTE_SLUG');
const frappe = new URL(need('MARKETPLACE_FRAPPE_RESTODEMO_URL'));
const auth = `token ${need('MARKETPLACE_FRAPPE_RESTODEMO_API_KEY')}:${need('MARKETPLACE_FRAPPE_RESTODEMO_API_SECRET')}`;
const posProfile = need('RECETTE_POS_PROFILE');
const channel = process.env.RECETTE_CHANNEL || 'Konektag';

// 1. Published profile, as rendered for the visitor.
const page = await fetch(new URL(`/marketplace/${slug}/`, web));
assert.equal(page.status, 200, `profile ${slug} is not published on ${web.origin}`);
const html = await page.text();
const dish = html.match(/data-add data-item-code="([^"]+)" data-item-name="([^"]+)" data-unit-price="([^"]+)"/);
assert.ok(dish, 'no orderable dish on the profile (restaurant capability not published?)');
const [, itemCode, itemName, unitPrice] = dish;
const currency = html.match(/data-restaurant data-slug="[^"]+" data-currency="([A-Z]{3})"/)?.[1];
assert.ok(currency, 'restaurant currency missing');
console.log(`Profile OK: ${itemName} (${itemCode}) at ${unitPrice} ${currency}`);

// 2. Order, then the identical replay.
const key = 'recette-' + randomUUID();
const body = JSON.stringify({ currency, lines: [{ itemCode, quantity: 1, unitPrice: Number(unitPrice) }],
  customer: { name: 'Recette Konektag', phone: process.env.RECETTE_PHONE || '+242060000000' }, note: 'Recette DESIGN #25', website: '' });
const send = () => fetch(new URL(`/api/public/marketplace/${slug}/restaurant/orders`, web), {
  method: 'POST', body,
  headers: { 'Content-Type': 'application/json', Origin: web.origin, 'Idempotency-Key': key },
});
const first = await send();
const firstBody = await first.json();
assert.equal(first.status, 201, `order refused: ${first.status} ${JSON.stringify(firstBody)}`);
const second = await send();
const secondBody = await second.json();
assert.equal(second.status, 200, `replay: ${second.status} ${JSON.stringify(secondBody)}`);
assert.equal(secondBody.replayed, true);
assert.equal(secondBody.reference, firstBody.reference, 'replay returned another reference');
console.log(`Order ${firstBody.reference} (${firstBody.status}); replay returned the same reference`);

// 3. Lumen holds exactly one order for this key, with that reference.
const q = new URLSearchParams({
  filters: JSON.stringify([['pos_profile', '=', posProfile], ['app_type', '=', channel], ['order_id', '=', key]]),
  fields: JSON.stringify(['name', 'status', 'total']), limit_page_length: '10',
});
const lumen = await fetch(new URL('/api/resource/POS Restaurant Order?' + q, frappe), { headers: { Authorization: auth, Accept: 'application/json' } });
assert.equal(lumen.status, 200, `Lumen read ${lumen.status}`);
const rows = (await lumen.json()).data;
assert.equal(rows.length, 1, `expected one order for the key, found ${rows.length}`);
assert.equal(rows[0].name, firstBody.reference, 'displayed reference differs from Lumen');
console.log(JSON.stringify({ result: 'PASS', key, reference: rows[0].name, lumenStatus: rows[0].status, total: rows[0].total }));
