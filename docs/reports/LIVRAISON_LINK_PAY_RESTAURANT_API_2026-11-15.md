# API Link Pay — source restaurant — 2026-11-15

## Changement

L’intégration Frappe existante accepte `sourceType: restaurant_order`, `sourceAttempt` et `posProfile`. Le montant, la devise, l’entreprise, l’ordre, l’empreinte et l’expiration proviennent exclusivement de `konektag_360.link_pay.pos.verify_attempt`. Le comportement d’émission Sales Invoice non-POS reste inchangé.

Le débit Points K revendique d’abord atomiquement le checkout PostgreSQL, puis la tentative native via `claim_attempt` avec le slug du lien comme clé stable. Une tentative modifiée, annulée ou étrangère au POS ne peut être débitée. Une réponse native incertaine laisse la source gelée ; une reprise avec la même clé retrouve le claim natif.

`DELETE /api/integrations/frappe/payment-links` révoque uniquement un lien ISSUED/EXPIRED, sous verrou source et verrou checkout. PROCESSING/CONSUMED refuse le dégel. Le RPC `release_attempt` doit accuser Cancelled avant commit. Si le RPC réussit mais le commit échoue, l’état natif Cancelled interdit tout débit ultérieur ; une nouvelle révocation peut terminer la réconciliation. Aucun verrou Frappe ne doit être conservé pendant l’appel HTTP vers l’API.

GET avec `sourceAttempt` et `posProfile` retrouve le lien et sa preuve de transaction : operationId et paidAt ne sont fournis qu’avec opération ledger completed. Le webhook signé ajoute sourceType/sourceAttempt/posProfile/sourceFingerprint. Il confirme le paiement ; seule l’interface du vrai caissier finalise ensuite la vente native avec le tender serveur.

## Données et fichiers

- Migration additive `240_link_pay_restaurant_source.sql` : source JSON privée sur les liens, invoice par défaut, unicité site/tentative restaurant. Aucune suppression de données.
- `restaurant-source.ts` : validation stricte et RPC native vérification/claim/release.
- `network-link-service.ts`, `network-payment.ts`, `site-webhook-service.ts` : source figée, verrous, révocation et preuve.
- Route intégration Frappe et registre : union émission, lecture source, DELETE sur le même endpoint.
- Générateur et OpenAPI documentent l’authentification site et les nouveaux corps.
- Trois fichiers unitaires ciblent source/compatibilité facture/révocation.

## Validation proportionnée

12 tests ciblés réussis dans quatre fichiers : 8 nouveaux cas source/route/révocation et 4 cas existants du canal historique retiré. TypeScript et build réussis. Aucun paiement réel, aucune fixture métier en production et aucune campagne élargie. La CI obligatoire habituelle reste inchangée.

## Dépendances de mise en service

Livrer la migration API avant d’activer les contrôles natifs. Les trois RPC service nécessitent l’allowlist DemoGuard exacte, authentification service et POS lié. `webhook.receive` nécessite son chemin exact et une signature validée nativement avant traitement. Toute incertitude conserve le gel.

RESTODEMO n’est pas prêt pour encaissement : lecture seule confirme aucune entrée RESTODEMO dans LINK_PAY_FRAPPE_SITES (seulement CONGO), aucune ligne commerciale API pour ce bénéficiaire ; côté Frappe aucun token site, aucune entreprise et aucun identifiant utilisateur du canal historique configurés. L’URL technique Marketplace existe. Aucun bénéficiaire approuvé ni frais n’a été inventé. Le code peut être livré mais la collecte reste désactivée jusqu’au provisionnement approuvé.

Les factures historiques conservent leur contrat antérieur. Cette extension sécurise les sources restaurant ; elle ne réécrit pas la concurrence historique entre plusieurs liens de factures indépendants et un encaissement externe.
