/** Source collections share the existing authenticated Frappe integration endpoint. */
export function documentLinkPaySources(paths) {
  const path = paths['/api/integrations/frappe/payment-links'];
  if (!path) return;
  const siteHeaders = [
    { name: 'X-Konektag-Frappe-Site', in: 'header', required: true, schema: { type: 'string' } },
    { name: 'X-Konektag-Frappe-Token', in: 'header', required: true, schema: { type: 'string', writeOnly: true } },
  ];
  for (const method of ['post','get','delete']) {
    const operation = path[method]; if (!operation) continue;
    operation.parameters = [...(operation.parameters || []).filter(p => !siteHeaders.some(h => h.name.toLowerCase() === p.name?.toLowerCase())), ...structuredClone(siteHeaders)];
    operation.description = 'Authenticated Frappe site integration. Site token authentication is required even though general session middleware permits this path. Restaurant sources are verified on the originating site and frozen; invoice collections preserve the existing non-POS Sales Invoice contract. No client amount is trusted.';
  }
  const source = { type: 'object', additionalProperties: false,
    required: ['sourceType','sourceAttempt','posProfile','beneficiarySite','networkSite'], properties: {
      sourceType: { const: 'restaurant_order' }, sourceAttempt: { type: 'string', format: 'uuid' },
      posProfile: { type: 'string', minLength: 1, maxLength: 140 },
      beneficiarySite: { type: 'string' }, networkSite: { type: 'string' }, description: { type: 'string', maxLength: 200 },
    } };
  path.post.requestBody = { required: true, content: { 'application/json': { schema: { oneOf: [source, {
    type: 'object', required: ['invoice','beneficiarySite','networkSite'], properties: {
      sourceType: { const: 'invoice' }, invoice: { type: 'string' }, beneficiarySite: { type: 'string' }, networkSite: { type: 'string' }, description: { type: 'string' },
    },
  }] } } } };
  path.get.parameters.push({ name: 'sourceAttempt', in: 'query', schema: { type: 'string', format: 'uuid' } },
    { name: 'posProfile', in: 'query', schema: { type: 'string' }, description: 'Required with sourceAttempt; invoice is the alternative legacy filter.' });
  path.delete.requestBody = { required: true, content: { 'application/json': { schema: {
    type: 'object', required: ['sourceAttempt','posProfile'], properties: source.properties.sourceAttempt ? {
      sourceAttempt: structuredClone(source.properties.sourceAttempt), posProfile: structuredClone(source.properties.posProfile),
    } : {},
  } } } };
  path.delete.responses = { '200': { description: 'Unpaid collection revoked and native attempt acknowledged as cancelled.' },
    '409': { description: 'Collection processing/paid, or native cancellation refused. Keep the source frozen.' },
    '503': { description: 'Uncertain remote outcome. Keep the source frozen and retry reconciliation.' } };
}
