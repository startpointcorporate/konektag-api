/** The merged monetary wallet service does not debit currency K.
 * Keep issuance and settlement closed until the approved K valuation/consumption
 * contract is implemented. Never turn this into an environment bypass. */
export async function requireOfflinePointsSettlement(): Promise<void> {
  throw new Error('OFFLINE_POINTS_SETTLEMENT_NOT_IMPLEMENTED');
}
