# Achat de Points K — flux 1 : Customer, Lead et Quotation ERPNext

`POST /api/points-k/quotations` prépare, sur le site ERPNext du pays choisi, une Quotation brouillon pour la plus
grande quantité entière de l'article demandé dont le total TTC arrondi, calculé par ERPNext, ne dépasse pas le
budget. Aucun paiement, aucune commande ni aucun mouvement de K n'est créé ici.

Service : `src/application/services/pay/points-k-quotation-service.ts` ; route : `src/api/routes/points-k/quotations.ts`.

## Requête

Route protégée (`/api/points-k/` dans `PROTECTED_PREFIXES`) : session Keycloak, Bearer OIDC ou clé API utilisateur.
L'identité retenue est `locals.user.keycloak_id` (le `sub` Keycloak) ; sans elle, `401 KEYCLOAK_IDENTITY_MISSING`.
Hors du préfixe `/api/pay/` : pas de `X-Idempotency-Key` exigée, l'idempotence est portée par ERPNext (voir plus bas).

```json
{ "country": "FR", "currency": "EUR", "budget": 100, "itemCode": "POINTS-K" }
```

| Champ | Règle |
|---|---|
| `country` | ISO 3166-1 alpha-2 **choisi par l'utilisateur** ; la résidence n'est qu'une présélection côté UI. `users.legal_country` n'est pas lu. |
| `currency` | ISO 4217 en majuscules ; doit être celle d'une liste de prix de vente de l'article sur le site. |
| `budget` | Nombre > 0, budget **maximal TTC** en unités de la devise. |
| `itemCode` | Article fourni par l'UI (Points K pour le parcours actuel) ; aucun article n'est codé dans l'API. |

Champ inconnu ou mal typé : `400 INVALID_REQUEST` (avec `fields`).

## Traitement

1. `country` → `payment_country_mappings` (règle active) → `konektag-<fr|cg|lb>` → site Frappe (résolveur partagé
   `routeKonektagFlow('points-k-quotation', country)`, ligne `[konektag-site]` journalisée).
2. Verrou PostgreSQL `pg_advisory_xact_lock('points-k-quotation|<site>|<keycloak_id>')` : deux appels du même
   utilisateur sur le même site sont sérialisés (attente maximale 20 s, sinon `409 QUOTATION_BUSY`).
3. `GET Item/<itemCode>` : existe, `disabled=0`, `is_sales_item=1`, pas de modèle à variantes.
4. `GET Item Price` (`item_code`, `selling=1`, `currency`) sans restriction client, valide ce jour, dans l'unité de
   stock ; puis `GET Price List/<nom>` : `enabled=1`, `selling=1`, même devise. Une seule liste doit rester ;
   `price_list_rate` doit être > 0. Aucun prix ni taux n'est inventé.
5. `Customer` filtré par `alias = keycloak_id` ; sinon créé (`customer_name` = username, `customer_type=Individual`,
   `alias`). `alias` est unique dans ERPNext : une création concurrente (409) est relue et réutilisée.
   Le Customer retourné doit porter exactement cet `alias`.
6. Lead lié dans les deux sens par champs natifs : `Lead.customer = Customer.name` **et**
   `Customer.lead_name = Lead.name` (voir « Liaison Customer ↔ Lead et conversion en Sales Order ») :
   - si `Customer.lead_name` est renseigné, ce Lead est utilisé (refus si absent, rattaché à un autre Customer ou
     désactivé) ; `Lead.customer` est complété s'il est vide ;
   - sinon `Lead` filtré par `customer = Customer.name`, non désactivé, ni « Do Not Contact » ni « Converted »
     (le plus ancien) ; sinon créé (`first_name`, `customer`) ; puis `PUT Customer {lead_name}` (seul champ écrit,
     `alias` inchangé), **avant** toute Quotation de ce Lead ;
   - contrôle final : `Customer` filtré par `lead_name = Lead` doit renvoyer exactement ce Customer.
7. Quotation brouillon du jour réutilisée (`quotation_to=Lead`, `party_name=Lead`, `docstatus=0`, même devise,
   liste et date, une seule ligne de cet article) ; sinon créée :
   `{quotation_to:"Lead", party_name, order_type:"Sales", transaction_date, currency, selling_price_list, items:[{item_code, qty, uom}]}`.
   L'API n'envoie ni `taxes`, ni `rate`, ni total, ni `taxes_and_charges`, ni `conversion_rate`.
8. Recherche de la quantité sur ce brouillon : chaque essai l'enregistre (`POST` puis `PUT items`) et lit le
   document recalculé par ERPNext. Total retenu : `rounded_total`, ou `grand_total` si `disable_rounded_total=1`.
   Le premier essai part de `floor(budget / prix HT)`, simple point de départ ; les suivants extrapolent le total
   unitaire observé, avec bissection de secours. Résultat prouvé sur le document : `total(q) ≤ budget < total(q+1)`.
   12 essais au plus (`503 QUANTITY_NOT_CONVERGED`) ; en pratique 2 à 4. Le brouillon finit sur `q`.

## Réponse

`201` si la Quotation est créée, `200` si le brouillon du jour est réutilisé.

```json
{
  "konektagSite": "konektag-fr",
  "paymentCountry": "FR",
  "site": { "key": "EUROPE", "host": "europe.erp.konektag.eu" },
  "customer": { "name": "CUST-00042", "created": true },
  "lead": { "name": "CRM-LEAD-2026-00017", "created": true },
  "quotation": {
    "name": "SAL-QTN-2026-00031", "created": true, "docstatus": 0, "status": "Draft", "company": "…",
    "currency": "EUR", "sellingPriceList": "Standard Selling", "itemCode": "POINTS-K", "qty": 83,
    "rate": 1, "priceListRate": 1, "netTotal": 83, "totalTaxesAndCharges": 16.6, "grandTotal": 99.6,
    "roundingAdjustment": 0, "roundedTotal": 99.6, "roundedTotalDisabled": false, "total": 99.6,
    "taxesAndCharges": "…", "taxes": [{ "chargeType": "On Net Total", "accountHead": "…", "description": "…", "rate": 20, "taxAmount": 16.6, "total": 99.6 }]
  },
  "budget": 100
}
```

Les valeurs de l'exemple sont illustratives (taux de 20 % supposé) : tous les montants et taux viennent du document ERPNext.

Garanties utilisées par les flux suivants (KON-69, KON-71) : la Quotation a **une seule ligne**, de l'article
demandé, avec une `qty` entière, dans l'unité de stock de l'article (`conversion_factor = 1`), et son Customer porte
`alias = keycloak_id` de l'acheteur. `Lead.customer = Customer.name` et `Customer.lead_name = Lead.name` :
`make_sales_order` sur cette Quotation reprend ce même Customer, sans en créer un second.

## Erreurs

| HTTP | Code | Cause |
|---|---|---|
| 400 | `INVALID_REQUEST` | corps invalide |
| 401 | `UNAUTHORIZED` / `Unauthorized` / `KEYCLOAK_IDENTITY_MISSING` | pas de session, ou utilisateur sans identité Keycloak |
| 422 | `RESIDENCE_COUNTRY_INVALID`, `COUNTRY_RULE_NOT_FOUND` | pays illisible ou sans règle active |
| 422 | `ITEM_NOT_FOUND`, `ITEM_NOT_SALEABLE` | article absent, désactivé, non vendable |
| 422 | `PRICE_NOT_FOUND`, `PRICE_INVALID` | aucune liste de prix de vente valide dans cette devise ; prix ≤ 0 |
| 422 | `NO_PURCHASE_POSSIBLE` (+ `budget`, `totalForOne`, `quotation`) | même 1 unité dépasse le budget TTC |
| 409 | `CUSTOMER_DISABLED`, `QUOTATION_BUSY` | Customer ou son Lead désactivé ; appel concurrent trop long |
| 502 | `ERPNEXT_REJECTED`, `CUSTOMER_IDENTITY_MISMATCH`, `QUOTATION_INCONSISTENT` | ERPNext refuse ou renvoie un document incohérent ; liaison Customer ↔ Lead contradictoire ou ambiguë (message ERPNext seulement dans les journaux) |
| 503 | `PRICE_AMBIGUOUS`, `QUANTITY_NOT_CONVERGED`, `ERPNEXT_UNAVAILABLE`, `COUNTRY_RULE_*`, `KONEKTAG_SITE_NOT_CONFIGURED` | configuration ou site indisponible |

## Contrat ERPNext vérifié (ERPNext 16.54.0, Frappe 16.55.2 — versions relevées dans konektag_360)

Vérifié dans les sources de ces versions, sans appel aux sites partagés (aucun identifiant de site n'est disponible
dans l'environnement de développement) :

- `Customer.alias` : champ natif `Data`, **unique**, dans `search_fields`. `Lead.customer` : champ natif `Link Customer`.
  `Customer.lead_name` : champ natif `Link Lead` (lecture seule dans Desk, `no_copy`, non unique, permlevel 0).
- REST v1 : `POST /api/resource/<DocType>` = `frappe.new_doc(**data).insert()` (valeurs par défaut appliquées, dont
  la société par défaut) ; `PUT /api/resource/<DocType>/<name>` = `doc.update(data); doc.save()` (une table enfant
  envoyée remplace les lignes) ; les deux renvoient le document enregistré.
- Quotation `quotation_to=Lead` : à l'enregistrement REST (`_action=save`), `set_missing_values(for_validate=True)`
  → `get_lead_details` → `set_taxes` (Tax Rule applicable au Lead) renseigne `taxes_and_charges` ; puis
  `set_taxes_and_charges` ajoute, si la Quotation n'a pas encore de lignes de taxes :
  les lignes du modèle **si** `Accounts Settings.add_taxes_from_taxes_and_charges_template = 1` (**défaut 0**) et
  celles du modèle de taxe de l'article (`Item Tax Template`) si `add_taxes_from_item_tax_template = 1` (défaut 1).
  Le modèle `is_default` n'est appliqué que par `set_taxes()` / `set_other_charges()`, jamais à la sauvegarde REST
  (c'est le formulaire Desk qui l'applique). `calculate_taxes_and_totals` recalcule ensuite à chaque sauvegarde.
- `rounded_total` = `round_based_on_smallest_currency_fraction(grand_total)` ; 0 si `disable_rounded_total`.
- Aucune méthode whitelistée ne calcule les totaux d'une Quotation sans l'enregistrer : le calcul passe donc par le
  brouillon, réutilisé, et non par un endpoint inventé.

## Liaison Customer ↔ Lead et conversion en Sales Order (correction de revue KON-69)

Constat (sources ERPNext 16.54.0, `selling/doctype/quotation/quotation.py`) : `make_sales_order` →
`_make_sales_order` → `_make_customer(quotation)` → `get_existing_customer_name("Lead", party_name)` =
`frappe.db.get_value("Customer", {"lead_name": party_name})`. Si aucun Customer ne porte ce `lead_name`,
`create_customer_from_lead` crée **un second Customer** (sans `alias`). `Lead.customer` n'est pas lu par ce mapper.
La première version (`445a15a`) ne posait que `Lead.customer` : la conversion aurait dédoublé le Customer.

Correction : l'API pose aussi `Customer.lead_name = Lead.name` (champ natif). Effets ERPNext vérifiés
(`selling/doctype/customer/customer.py`) :
- `validate_lead_not_converted` ne s'applique qu'à la création d'un Customer ; le Customer existant est mis à jour.
- `on_update` (si `lead_name` change) / `after_insert` → `update_lead_status` : Lead → « Converted » et les
  Quotations existantes `quotation_to=Lead, party_name=Lead` sont **réaffectées au Customer** ; d'où la pose du lien
  avant toute Quotation de ce Lead (un brouillon antérieur à la correction est ainsi réaffecté et un nouveau
  brouillon est créé).
- Une Quotation vers un Lead « Converted » reste acceptée : `validate_lead_is_enabled` ne refuse qu'un Lead
  `disabled` (`crm/doctype/lead/lead.py`).
- Frappe 16.55.2 REST (`api/v1.py`) : `update_doc` = `doc.update(data); doc.save()` ; le caractère « lecture seule »
  d'un champ n'est pas imposé côté serveur (seuls permlevel et `set_only_once` le sont).

Test de régression : le faux ERPNext reproduit `update_lead_status` et `_make_customer` ; la conversion de la
Quotation doit renvoyer le Customer d'origine (`alias = keycloak_id`), sans nouveau Customer. Ce test échoue sur
`2ee6f6c`.

## Responsabilité fiscale (décision du 2026-11-11)

La configuration fiscale et l'application des taxes appartiennent exclusivement à ERPNext. L'API ne configure aucune
taxe, n'ajoute aucun repli de calcul fiscal et ne lit aucun modèle de taxes pour le compléter : elle crée la Quotation
native, lit les totaux calculés par ERPNext et garantit que le total TTC arrondi ne dépasse pas le budget.
Le contrat API ne dépend donc pas de la configuration ERPNext : avec ou sans lignes de taxes, la réponse reflète
exactement le document ERPNext (`taxes`, `totalTaxesAndCharges`, `total`).

**Point de recette ERPNext, séparé de ce contrat** (configuration de chaque site FR/CG/LB, sans changement Frappe ni
code API) : pour que la Quotation créée par REST porte ses taxes, le site doit avoir soit
`Accounts Settings.add_taxes_from_taxes_and_charges_template = 1` avec une Tax Rule applicable au Lead, soit un
`Item Tax Template` sur l'article Points K. Sinon ERPNext enregistre la Quotation sans taxe (`taxes: []`) et le total
TTC est alors égal au total HT.

## Limites connues

- Les lignes de taxes sont fixées à la création du brouillon (comportement ERPNext) ; un changement de configuration
  fiscale s'applique au brouillon du jour suivant.
- La société est la société par défaut du site ; les taux de change éventuels sont ceux d'ERPNext.
- Une demande refusée (`NO_PURCHASE_POSSIBLE`) laisse le brouillon du jour à 1 unité ; il est réutilisé ensuite.
- L'unicité du Lead par Customer n'est pas garantie par ERPNext (`lead_name` non unique) : elle repose sur le verrou
  PostgreSQL et sur le contrôle `Customer[lead_name = Lead]` = ce seul Customer.
- La conversion en Sales Order n'est vérifiée que contre les sources ERPNext et un faux ERPNext, pas sur un site.
- La maximalité suppose un total croissant avec la quantité (cas des taxes en pourcentage ou fixes) ; une règle de
  prix dégressive pourrait la mettre en défaut, mais `total(q) ≤ budget` reste toujours vrai.
- Droits du compte de service : lecture Item/Item Price/Price List, lecture/création/écriture Customer et Lead,
  lecture/création/écriture Quotation sur chaque site — non vérifiés en direct.
- Tarifs installés selon le cadrage : FR 1 EUR/K HT, CG 655 XAF/K HT, LB 1 USD/K HT ; l'API les lit dans ERPNext.

## Tests

`tests/unit/points-k-quotation.test.ts` simule un ERPNext par hôte qui applique ses taxes et calcule ses totaux ;
chaque quantité attendue vient d'un balayage exhaustif de ces totaux, indépendant de l'algorithme.
`tests/unit/points-k-quotation-auth.test.ts` vérifie la protection de la route par le middleware réel.

## Recette réelle en production — 11 novembre 2026

Recette exécutée sur EUROPE, KONEKTAG_CG et LIBAN depuis le pod API existant,
avec le code de la branche KON-68, les identifiants de service existants et des
données identifiées `KON68 TEST`, après autorisation explicite de l'utilisateur.
Le scénario rejouable est `tests/integration/points-k-quotation.live.ts` ; il reste
hors de la suite automatique et exige `KON68_ALLOW_SHARED_SITE_TEST_WRITES=YES`,
un `KON68_TEST_RUN_ID` explicite et un chemin de résultat privé sous `/tmp/`.
Il utilise les vrais clients HTTP Frappe, le routage PostgreSQL et les verrous,
sans ERPNext simulé. L'identifiant Keycloak de recette est injecté à l'entrée du
service : ce test ne déploie pas la route publique ni ne rejoue un login Keycloak.

Deux réglages natifs ont été corrigés pendant la recette :

- lecture de `Item Price` accordée uniquement aux trois comptes de service via
  le rôle `Konektag Points K Price Reader` (read/select, aucune écriture de prix) ;
- Congo : `Accounts Settings.add_taxes_from_taxes_and_charges_template=1` et
  `add_taxes_from_item_tax_template=0`, ces options étant mutuellement exclusives.
  Cela charge les deux lignes du modèle composé sur l'insertion REST d'une
  Quotation vers un Lead. La seule TVA positive ne suffit pas à vérifier ce cas.

Le test compare les comptes et types de **toutes** les lignes du modèle natif,
vérifie `total(q) <= budget < total(q+1)`, rejoue le flux pour vérifier sa réutilisation,
puis soumet uniquement la Quotation de test (prérequis du mapper natif) et crée
le Sales Order en brouillon. Aucun paiement, facture ni écriture comptable.

La conversion native reprend le Customer initial et son alias ; le nombre de
Customers ne change pas et les liens `Customer.lead_name` / `Lead.customer`
restent cohérents. Résultats et pièces de recette :
[rapport du 11 novembre 2026](reports/KON68_RECETTE_PRODUCTION_2026-11-11.md).
