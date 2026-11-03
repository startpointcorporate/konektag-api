import {merchantCatalogAccess} from './merchant-catalog-access.ts';
import {entitlementDecisionService,type CapabilityCode} from './entitlement-decision-service.ts';
import {proPrice} from './subscription-pricing.ts';
import {VisibilityError,visibilityManager} from './visibility-shared.ts';
const contexts:Record<string,{capability:CapabilityCode;title:string;benefit:string}>={
 analytics:{capability:'analytics.export',title:'Exporter vos résultats',benefit:'Analysez vos résultats dans vos propres outils grâce à l’export.'},
 catalog:{capability:'catalog.manage',title:'Gérer vos produits dans ERPNext',benefit:'Gérez votre catalogue dans ERPNext avec l’offre Pro. Vous vous connecterez directement dans ERPNext.'},
 integrations:{capability:'integration.api',title:'Connecter vos outils métier',benefit:'Utilisez l’API et les intégrations prévues par votre abonnement.'},
};
export async function merchantUpgradeAdvice(actor:string,merchantId:string,context:string){const c=contexts[context];if(!c)throw new VisibilityError('INVALID_UPGRADE_CONTEXT');const merchant=await visibilityManager(actor,merchantId);
 const decision=await entitlementDecisionService.decide({actorId:actor,merchantId,capability:c.capability});
 const needsPro=!decision.allowed&&['SUBSCRIPTION_INACTIVE','SUBSCRIPTION_EXPIRED'].includes(decision.reasonCode);
 if(!decision.allowed&&!needsPro)throw new VisibilityError('MERCHANT_ACCESS_DENIED',403);
 const catalogAccess=context==='catalog'?await merchantCatalogAccess(actor,merchantId):undefined;
 return {context,...c,catalogAccess,available:decision.allowed,needsPro,subscriptionState:decision.subscriptionState,
 monthly:proPrice('MONTHLY'),annual:proPrice('ANNUAL'),profileSlug:merchant.slug,
 free:'Votre fiche publique, le partage, les avis et la saisie des espèces restent utilisables gratuitement. Les paiements Points K dépendent de l’approbation KYB, indépendamment de l’abonnement.',
 business:'Un besoin spécifique de gestion ou d’accompagnement ? L’offre Business se définit avec vous, sur devis. Aucun périmètre ni tarif supplémentaire n’est activé automatiquement.'};
}

