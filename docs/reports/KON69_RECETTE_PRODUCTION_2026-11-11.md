# KON-73 — recette réelle de KON-69 — 2026-11-11

Recette **partielle, bloquée avant écriture** sur les trois ERPNext de production. Le service non fusionné de PR #54 a été exécuté contre leurs vraies API, avec routage PostgreSQL et comptes de service existants. Aucun mock ERPNext, paiement, déploiement, migration ou merge.

## Résultat par site

| Contrôle réellement exécuté | France | Congo | Liban |
|---|---|---|---|
| Site HTTPS | europe.erp.konektag.eu | congo.erp.konektag.eu | liban.erp.konektag.eu |
| Routage réel | FR / EUROPE | CG / KONEKTAG_CG | LB / LIBAN |
| Identité authentifiée | api-europe@konektag.eu | api-congo@konektag.eu | api-lebanon@konektag.eu |
| Quotation de recette existante | soumise, docstatus=1 | soumise, docstatus=1 | soumise, docstatus=1 |
| Customer.alias / ownership Lead | concordants | concordants | concordants |
| Sujet Keycloak étranger | CUSTOMER_NOT_OWNED | CUSTOMER_NOT_OWNED | CUSTOMER_NOT_OWNED |
| HT / taxes natives | 10 / 2 EUR | 7 205 / 1 361,74 XAF | 11 / 1,21 USD |
| grand_total / rounded_total | 12 / 12 EUR | 8 566,74 / 8 567 XAF | 12,21 / 12,21 USD |
| TTC retenu | 12 EUR | 8 567 XAF | 12,21 USD |
| Sales Orders existants du Customer | 3 brouillons | 2 brouillons | 3 brouillons |
| Lecture checkout, deux tentatives | profil non approuvé | profil non approuvé | profil non approuvé |
| Handler GET corrigé | 422, code explicite | 422, code explicite | 422, code explicite |
| Droits effectifs QTN/SO/PR read/create/write/submit | oui | oui | oui |
| Méthodes submit / mapper / make_payment_request whitelistées | oui | oui | oui |
| Payment Gateway Account | aucun | aucun | aucun |
| Nouvelle soumission QTN/SO/PR pendant KON-73 | non exécutée | non exécutée | non exécutée |
| Idempotence création / concurrence / reprise | non validée | non validée | non validée |

La soumission des devis et l'insertion des commandes brouillons sont des faits **préexistants de KON-68**, relus pendant cette mission. Aucun nouveau mapper ni POST checkout n'a été exécuté ici. Au Congo, un ancien Sales Order de recette vaut 9 275 XAF ; le final vaut 8 567 XAF. Ne pas confondre cet ancien essai avec le devis final.

## Blocages constatés et intervention minimale

Les profils LINK-FR-STRIPE, LINK-CG-PAWAPAY et LINK-LB-STRIPE portent `runtime_operation=link_payment`, mais leur statut réel est **Compliance Review**. Le résolveur exige `Approved`. Les trois corridors internes correspondants sont Approved ; cela ne rend pas les profils éligibles. Le service lève `PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND` avant toute soumission. Deux appels par pays reproduisent ce même refus : cela prouve la stabilité du refus, **pas l'idempotence d'une création**.

Le responsable habilité doit terminer la revue et l'approbation natives des profils, puis faire vérifier les acteurs/providers et leur configuration. Cette mission n'autorise pas à passer ces contrôles ni à approuver ces profils. Aucun paramétrage métier ou fiscal n'a été modifié.

L'absence de Payment Gateway Account est relevée ; elle n'est pas présentée comme une exception effectivement levée par make_payment_request, qui n'a pas été appelée. Les modes actifs sont Bank Draft, Cash, Cheque, Credit Card et Wire Transfer ; CG ajoute Konektag Link Pay. Leur présence ne prouve pas une correspondance avec un provider autorisé.

La chaîne API effectue plusieurs requêtes Frappe HTTP séparées et une insertion PostgreSQL : un rollback Bench unique ne couvre pas ces transactions. Le contrôleur natif Payment Request appelle, selon la configuration, request_phone_payment ou get_payment_url pendant before_submit ; mute_email ne désactive que l'email. Les hooks Quotation/Sales Order incluent Konektag et CRM. Aucun contexte isolé couvrant ces sorties et toutes les transactions n'a été établi. Les écritures sont donc restées interdites dans cette recette, conformément à la mission.

Après levée du blocage de configuration, il restera à établir ce contexte réversible sur les sites réels avant de soumettre SO/PR et de tester les rejeux/concurrences. Ne pas déployer l'API pour contourner ce blocage. L'index PostgreSQL d'unicité erpnextPointsK n'existe pas dans la base partagée actuelle : résultat attendu pour cette PR non déployée ; aucune migration exécutée. La persistance de metadata et son unicité nécessitent une base PostgreSQL isolée.

## Défaut API corrigé dans PR #54

Le handler checkout ne reconnaissait pas PaymentContextResolutionError : le refus réel ci-dessus devenait une erreur générique HTTP 500. GET et POST utilisent maintenant paymentContextErrorStatus et exposent uniquement le code métier, HTTP 422 pour ce cas. Aucun assouplissement de contrôle. Le handler GET corrigé a été appelé en processus contre chaque vrai ERPNext et retourne bien ce résultat. Le POST corrigé est vérifié uniquement en test unitaire ; aucun POST réel n'est revendiqué.

## Preuves et absence d'effet de bord

[Preuves JSON anonymisées](KON69_RECETTE_PRODUCTION_PREUVES_2026-11-11.json) : réponses métier réelles, permissions Bench, profils/corridors, devis/taxes, comptes avant/après et PostgreSQL en transaction READ ONLY. Les noms et alias Customer/Lead ne sont pas publiés dans les preuves ; les UUID du harnais sont exclusivement les identités de test KON-68. Aucune identité client réel ni valeur de Secret n'est utilisée ou publiée.

| Comptages natifs avant → après | France | Congo | Liban |
|---|---|---|---|
| Customer | 2 → 2 | 4 → 4 | 2 → 2 |
| Quotation | 3 → 3 | 3 → 3 | 3 → 3 |
| Sales Order | 3 → 3 | 2 → 2 | 3 → 3 |
| Payment Request / Sales Invoice / Payment Entry / GL Entry | chacun 0 → 0 | chacun 0 → 0 | chacun 0 → 0 |
| Email Queue | 0 → 0 | 0 → 0 | 0 → 0 |
| Communication | 2 → 2 | 11 → 11 | 0 → 0 |
| Notification Log | 2 → 2 | 330 → 330 | 0 → 0 |

PostgreSQL : api_payment_orders=0, dont erpnextPointsK=0. Le harnais n'appelle aucun créateur de commande, PSP ou portefeuille. Les comptages identiques sont des preuves complémentaires ; ils ne sont pas présentés comme une surveillance exhaustive de tous les canaux externes. Aucun chemin de soumission ou notification n'a été exécuté. Les données existantes KON-68 sont conservées sans modification ni nettoyage hors périmètre.

## Reproduction et validation

- Base PR inspectée : 48460c1520afb8e983a7df50d927b551069999e3.
- Harnais : tests/integration/points-k-checkout.live.ts, opt-in hors suite unitaire ; bundle esbuild platform=node, format=esm, packages=external, exécution sous /tmp/kon73-acceptance dans le pod API existant avec ses variables et dépendances. Aucun fichier actif, image ou Deployment changé.
- Exemple de compilation : `./node_modules/.bin/esbuild tests/integration/points-k-checkout.live.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/kon73-live.mjs`.
- Bench : `ssh konektag-core`, kubectl namespace konektag-common, `bench --site SITE console`, lecture des permissions/méthodes/hooks et comptages, puis rollback. Sites toujours explicitement ciblés.
- Harnais : vrais clients Frappe, routage et contexte ; identité Keycloak de recette injectée à l'entrée du service/handler. Aucun login navigateur/Keycloak ni endpoint public déployé testé.
- `npm run typecheck` : réussi.
- Tests unitaires ciblés : 3 fichiers, 6 tests réussis (checkout, erreurs GET/POST, auth quotation). Ils utilisent des doublures et ne sont **pas** des preuves de recette production. Premier lancement sans DATABASE_URL arrêté à l'import ; relance avec URL locale factice sans connexion, réussie. CI a ensuite confirmé cette dépendance indue dans les deux fichiers checkout ; ils isolent maintenant le créateur de commande de paiement dans les tests unitaires, sans DATABASE_URL ni connexion. Le harnais réel reste sans mocks.
- CI GitHub : à lire sur le SHA publié de PR #54 ; aucune réussite anticipée. Le workflow deploy exclut la CI des PR et les push hors main.
- Paperclip : les commentaires historiques confirment deux « ACP agent reported a terminal limit failure ». Lecture/écriture du connecteur opérationnelles ici ; aucune opération de logs d'exécution proposée par search_api. Cause interne du runner non établie, pas de relance d'agent. La recette a été reprise directement via SSH depuis ce poste.

Conclusion : accès, ownership négatif, TTC, devis préexistants, configuration et refus réel vérifiés sur FR/CG/LB. **Quotation → Sales Order soumis → Payment Request soumise, conservation Customer après ces soumissions, montants PR, idempotence de création et metadata PostgreSQL restent non validés.** KON-73 ne constitue pas une autorisation de fusion ou de production.
