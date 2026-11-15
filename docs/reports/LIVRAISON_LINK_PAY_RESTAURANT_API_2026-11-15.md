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

13 tests ciblés réussis dans quatre fichiers : 9 nouveaux cas source/route/révocation/refus avant débit et 4 cas existants du canal historique retiré. TypeScript et build réussis. Aucun paiement réel, aucune fixture métier en production et aucune campagne élargie. La CI obligatoire habituelle reste inchangée.

## Dépendances de mise en service

Livrer la migration API avant d’activer les contrôles natifs. Les trois RPC service nécessitent l’allowlist DemoGuard exacte, authentification service et POS lié. `webhook.receive` nécessite son chemin exact et une signature validée nativement avant traitement. Toute incertitude conserve le gel.

La configuration technique locale RESTODEMO était absente ; cela ne démontre pas une absence d’accord commercial. La collecte globale existante CONGO→CONGO est approuvée/enabled, Exempt0. Le restaurant dispose déjà d’un Customer et de l’abonnement K360-DEMO-VALIDATION-restodemo sur Congo. La correction réutilise ce collecteur, sans nouveau bénéficiaire ni duplication d’approbation : issuer/POS RESTODEMO/Restaurant démo, collector/network CONGO, callback sur issuer RESTODEMO. Les autres frais, notamment recharges, restent hors périmètre et inchangés.

Les factures historiques conservent leur contrat antérieur. Cette extension sécurise les sources restaurant ; elle ne réécrit pas la concurrence historique entre plusieurs liens de factures indépendants et un encaissement externe.

## Livraison suivie

Issue70 et PR71. La migration240 a été appliquée seule en production via le propriétaire PostgreSQL, sous verrou officiel772946131 et transaction ; précédent239/checksum vérifiés. SHA256240 : `3b38cf5ca14a72a6cf75d70f74f69ed622076a1e2912078e67ff545ac59dd113`. Deux colonnes et index unique présents après application. Le rôle runtime API n’a reçu aucun droit DDL.

La CI a validé SQL240 sur PostgreSQL jetable et 3062 assertions (3057 réussies,5 expected-fail préexistantes). Les comptes inventaire et les rapports de couverture ont été actualisés pour425 opérations ; couverture générée depuis l’artefact réel de CI43691263528, seuls préfixes de chemins normalisés, sans rejouer la suite manuellement.

## Correction de routage central

La configuration API `restaurantCollectors` lie exactement le POS authentifié à son collecteur. Une tentative ne peut ni choisir un autre collecteur, ni étendre cette règle à une facture historique. Le claim revalide ce rattachement avant débit ; les sources restaurant exigent Exempt0. La migration241 additive ne relâche issuer=beneficiary que pour une source restaurant portant explicitement son collectorSite. Le callback rejoint l’issuer/POS, tandis que la transaction financière conserve CONGO comme bénéficiaire.

Provisionnement purement technique : identité RESTODEMO et HMAC propres, même secret registry partagé par API/outbox, clés natives transmises via fichier privé600. La ligne commerciale CONGO, son approbation et ses frais ne sont pas modifiés.
