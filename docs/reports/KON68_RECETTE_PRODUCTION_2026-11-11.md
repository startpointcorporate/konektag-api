# KON-68 / KON-69 — recette réelle en production — 2026-11-11

## Conclusion

Recette métier réelle concluante sur France, Congo et Liban après correction de deux paramétrages ERPNext. Le mapper natif Quotation → Sales Order reprend le Customer initial sur les trois sites, sans création supplémentaire et sans perte d'alias.

La PR `startpointcorporate/konektag-api#52` reste en brouillon. Aucun merge ni déploiement. Le code métier de KON-68/KON-69 n'a pas nécessité de correction supplémentaire : les blocages observés étaient des données de permission et de configuration natives.

## Autorisation et périmètre effectif

- L'utilisateur a explicitement autorisé les écritures de test sur les trois sites de production, puis demandé la correction des blocages.
- Toutes les données de recette portent une identité `KON68 TEST kon68-20261111-production-1`. Aucun Customer réel existant n'a été réaffecté.
- Code du service issu du head de PR `81b2848858b426912476ca0e3cfa92356220ebea`, exécuté en processus de recette dans le pod API existant.
- Routage, PostgreSQL et verrous réels, HTTPS vers les vrais sites ERPNext, comptes de service et Secrets existants ; aucun ERPNext simulé, nouveau jeton ou mécanisme d'authentification.
- Le harnais n'a été placé que sous `/tmp` dans le pod ; aucune version active de l'API ou image déployée n'a été changée.
- La recette injecte un UUID de sujet Keycloak à l'entrée du service. Elle ne rejoue pas un login Keycloak ni l'endpoint public non déployé de la PR ; les tests du middleware/route restent distincts.
- Frappe 16.55.2, ERPNext 16.54.0 sur les trois sites ; image partagée `konektag/erpnext:v16.54.0-k360-f394a8a-20261110`.

## Routage et authentification réels

Les règles actives de `konektag.payment_country_mappings` correspondent à FR → FR, CG → CG, LB → LB. Les slugs `konektag-fr`, `konektag-cg`, `konektag-lb` résolvent les clés suivantes via la configuration existante.

| Pays | Clé Frappe | Hôte HTTPS | Compte de service authentifié |
|---|---|---|---|
| FR | EUROPE | europe.erp.konektag.eu | api-europe@konektag.eu |
| CG | KONEKTAG_CG | congo.erp.konektag.eu | api-congo@konektag.eu |
| LB | LIBAN | liban.erp.konektag.eu | api-lebanon@konektag.eu |

Les variables `MARKETPLACE_FRAPPE_EUROPE_*`, `MARKETPLACE_FRAPPE_KONEKTAG_CG_*` et `MARKETPLACE_FRAPPE_LIBAN_*` sont présentes et pointent vers les hôtes attendus. Les identifiants proviennent des Secrets existants `marketplace-frappe-europe`, `marketplace-frappe-konektag-cg` et `marketplace-frappe-liban`.

Les appels authentifiés depuis le pod API retournent HTTP 200 pour l'identité, Item, Item Price, Customer, Lead, Quotation et Sales Order après correction. Aucun Secret n'est reproduit dans le rapport ni dans Git.

## Blocages corrigés

### Lecture du tarif — trois sites

Cause : HTTP 403 sur Item Price ; les trois comptes de service avaient read=false sur ce DocType. Le service KON-68 s'arrêtait avant toute création de Customer/Lead/Quotation.

Correction native appliquée : rôle `Konektag Points K Price Reader`, read/select sur Item Price, aucune permission de création, écriture, suppression, export ou partage de prix. Rôle affecté uniquement au compte de service correspondant dans chacun des trois sites. `frappe.permissions.add_permission` / `update_permission_property` et `User.add_roles` ont été utilisés ; identifiants et authentification inchangés.

Les droits Customer et Lead read/create/write, Quotation create/write/submit et Sales Order create étaient déjà présents. Aucun rôle administrateur n'a été accordé aux comptes de service.

### Taxes composées sur Quotation vers Lead — Congo

Cause : le modèle `Congo Tax - KC` était sélectionné dans l'en-tête, mais ses lignes n'étaient pas copiées lors de l'insertion REST. Seule la TVA de l'Item Tax Template était ajoutée ; les centimes manquaient.

Correction native validée et appliquée sur le seul site Congo :

- `Accounts Settings.add_taxes_from_taxes_and_charges_template = 1` ;
- `Accounts Settings.add_taxes_from_item_tax_template = 0`.

Ces options sont mutuellement exclusives dans cette version d'ERPNext. Les taux spécifiques d'article restent disponibles dans le calcul ; les lignes et la dépendance des centimes proviennent du modèle de vente. Les données fiscales françaises/libanaises et les modèles/taux n'ont pas été modifiés pendant cette mission.

Le brouillon de recette créé avant correction a été rechargé depuis le modèle natif. Aucun devis commercial préexistant n'a été retouché. Le test a été renforcé : une taxe positive ne suffit plus ; chaque compte et type de ligne du modèle natif doit être présent.

## Tableau de recette final

| Contrôle | France | Congo | Liban |
|---|---|---|---|
| Connexion API | OK | OK | OK |
| Customer / Keycloak | OK | OK | OK |
| Lead / Customer | OK | OK | OK |
| Tarification | OK | OK | OK |
| Quotation | OK | OK | OK |
| Fiscalité | OK | OK | OK |
| Budget TTC | OK | OK | OK |
| Conversion Sales Order | OK | OK | OK |
| Absence de doublon Customer | OK | OK | OK |

## Prix, taxes et borne maximale du budget

Prix natifs de POINTS-K via Standard Selling et Item Price : FR 1 EUR, CG 655 XAF, LB 1 USD. Aucun prix, taux ni montant de taxe n'est envoyé par l'API lors de l'insertion ou mise à jour du brouillon.

| Pays | Devise | Budget TTC | Quantité max | HT | Taxes | Grand total | TTC retenu par ERPNext | Quantité suivante / TTC |
|---|---|---:|---:|---:|---:|---:|---:|---|
| FR | EUR | 12.35 | 10 | 10.00 | 2.00 | 12.00 | 12.00 | 11 → 13.20 |
| CG | XAF | 9300.00 | 11 | 7205.00 | 1361.74 | 8566.74 | 8567.00 | 12 → 9346.00 |
| LB | USD | 12.50 | 11 | 11.00 | 1.21 | 12.21 | 12.21 | 12 → 13.32 |

Les quantités suivantes ont été réellement enregistrées sur le même brouillon pour lire le total ERPNext, puis la quantité retenue a été restaurée. Pour chaque site, `TTC(q) <= budget < TTC(q+1)` est vérifié. Le budget Congo de 9 300 XAF distingue le bon résultat de celui qui oubliait les centimes.

Lignes de taxes réellement retournées :

- FR : 4457101 - TVA 20% Collectée - KE : 2.00 (On Net Total).
- CG : VAT - KC : 1296.90 (On Net Total); 4422-Impôts et taxes pour les collectivités publiques - KC : 64.84 (On Previous Row Amount).
- LB : VAT - KL : 1.21 (On Net Total).

EUR/USD : centimes ; XAF : total arrondi à l'unité selon la configuration existante. Au Congo, les centimes additionnels du scénario sont de 64,84 XAF sur 1 296,90 XAF de TVA, avec l'arrondi natif existant (Banker's Rounding). Aucun calcul fiscal alternatif n'a été introduit dans l'API.

## Customer, Lead et conversion native KON-69

Les premiers essais ont créé une seule paire Customer/Lead par site. Les appels suivants, y compris les rejeux après correction, réutilisent cette paire. Le second appel de chaque recette finale réutilise également le même brouillon.

- FR : UUID de recette `cb19d1b0-1787-491e-abbf-d9a385c6ae19`, alias unique ; premier et second appel sur le même Customer/Lead/brouillon.
- CG : UUID de recette `805b13b8-3a20-407f-aef4-9a4b52416079`, alias unique ; premier et second appel sur le même Customer/Lead/brouillon.
- LB : UUID de recette `8e9ccf2e-d8e9-4abc-ae06-275aecddfb41`, alias unique ; premier et second appel sur le même Customer/Lead/brouillon.

- `Customer.alias` égale exactement l'UUID de recette transmis au service.
- `Customer.lead_name = Lead.name` et `Lead.customer = Customer.name`, avant et après conversion.
- La Quotation est créée en brouillon, vers le Lead lié.
- Le mapper natif exige docstatus=1 sur la Quotation : seule la Quotation de recette est soumise ensuite.
- L'appel réel à `erpnext.selling.doctype.quotation.quotation.make_sales_order` retourne le Customer initial.
- Le Sales Order obtenu est ensuite réellement enregistré en brouillon et garde ce Customer.
- Le comptage global des Customers est identique juste avant/après le mapper ; un seul Customer existe par alias et par lien de Lead.

| Pays | Customer initial | Lead | Quotation finale | Sales Order brouillon | Customers avant → après mapper |
|---|---|---|---|---|---|
| FR | `KON68 TEST kon68-20261111-production-1 FR` | `CRM-LEAD-2026-00004` | `SAL-QTN-2026-00003` | `SAL-ORD-2026-00003` | 2 → 2 |
| CG | `KON68 TEST kon68-20261111-production-1 CG` | `CRM-LEAD-2026-00113` | `SAL-QTN-2026-00003` | `SAL-ORD-2026-00002` | 4 → 4 |
| LB | `KON68 TEST kon68-20261111-production-1 LB` | `CRM-LEAD-2026-00002` | `SAL-QTN-2026-00003` | `SAL-ORD-2026-00003` | 2 → 2 |

## Absence d'effet financier et inventaire des données de test

Contrôle natif indépendant après recette, pour tous les devis et commandes liés aux trois identités de recette (y compris essais intermédiaires) : zéro GL Entry, zéro ligne de Sales Invoice, zéro Payment Entry Reference et zéro Payment Request. Tous les Sales Orders de recette restent docstatus=0.

- europe.erp.konektag.eu : devis de recette `SAL-QTN-2026-00003` (docstatus=1), `SAL-QTN-2026-00002` (docstatus=1), `SAL-QTN-2026-00001` (docstatus=1) ; Sales Orders `SAL-ORD-2026-00003` (brouillon), `SAL-ORD-2026-00002` (brouillon), `SAL-ORD-2026-00001` (brouillon).
- congo.erp.konektag.eu : devis de recette `SAL-QTN-2026-00003` (docstatus=1), `SAL-QTN-2026-00002` (docstatus=1) ; Sales Orders `SAL-ORD-2026-00002` (brouillon), `SAL-ORD-2026-00001` (brouillon).
- liban.erp.konektag.eu : devis de recette `SAL-QTN-2026-00003` (docstatus=1), `SAL-QTN-2026-00002` (docstatus=1), `SAL-QTN-2026-00001` (docstatus=1) ; Sales Orders `SAL-ORD-2026-00003` (brouillon), `SAL-ORD-2026-00002` (brouillon), `SAL-ORD-2026-00001` (brouillon).

Les données de recette restent identifiées pour revue ; aucune suppression ni annulation de données commerciales réelles. Aucun paiement, facture ou commande soumise n'a été déclenché.

## Tests et preuves rejouables

- `tests/integration/points-k-quotation.live.ts` : clients Frappe réels, contrôles de propriété des documents de recette, liste limitée de DocTypes en écriture, aucune saisie de prix/taxes, contrôle de toutes les lignes fiscales, borne TTC, double appel, mapper puis Sales Order brouillon.
- Exécution explicite uniquement : `KON68_ALLOW_SHARED_SITE_TEST_WRITES=YES`, `KON68_TEST_RUN_ID` et `KON68_RESULT_PATH` privé sous `/tmp/`. Le fichier n'est pas inclus dans la suite unitaire automatique.
- Compilation du harnais avec esbuild, puis exécution dans le pod API avec les dépendances et variables existantes. Aucun changement du Deployment.
- 34 tests ciblés Quotation/auth réussis.
- Suite complète : 176 fichiers, 2 820 réussis et 5 expected fail préexistants, soit 2 825 tests.
- `tsc --noEmit` réussi.
- Empreinte SHA-256 du résultat JSON privé de recette finale : `88b000167059fe8e0794efd4beeedbff883a20c5f727215f319afea68b37f798`.

Les corrections ont été appliquées nativement dans ERPNext. La PR #52 est complétée avec ce scénario et cette preuve de recette ; elle reste non fusionnée et non déployée.
