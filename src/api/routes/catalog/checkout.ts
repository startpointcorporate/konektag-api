import type {RouteHandler} from '../../http';
import {LINK_PAY_MERCHANT_PROFILE_RETIRED} from '../../../application/services/payment-link-service.ts';
import {operationsJson} from '../../../application/merchant-operations-http.ts';

// Catalogue checkout paid by a Link Pay link of a merchant profile is retired: Link Pay is collected
// for a Frappe site through its network. Refused before any cart quote or core transaction.
export const POST:RouteHandler=async({locals})=>{
 if(!locals.user)return operationsJson({error:'Connectez-vous pour accéder au paiement.'},401);
 return operationsJson({error:LINK_PAY_MERCHANT_PROFILE_RETIRED},410);
};
