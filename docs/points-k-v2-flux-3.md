# Points K V2 — flux 3 : confirmation, facture, règlement et crédit K

Achat de Points K uniquement. ERPNext reste le système comptable : aucune écriture comptable ni aucun DocType ne sont ajoutés côté Konektag. PostgreSQL garde seulement le journal de traitement (`konektag.points_k_settlements` et `konektag.points_k_settlement_steps`, migration 234) et le registre K existant.

## Enchaînement

1. Les webhooks **existants** reçoivent la confirmation : `POST /api/webhooks/stripe` (et `/api/webhooks/stripe/{configurationKey}`) vérifient la signature Stripe ; `POST /api/webhooks/pawapay/deposits` vérifie la signature HTTP pawaPay (ECDSA P-256, `Content-Digest`). Les services existants comparent ensuite le montant et la devise du prestataire à la tentative `payment_provider_attempts`. Une redirection navigateur n'atteint jamais ce code : seule une tentative `succeeded`, liée à un événement prestataire vérifié, déclenche la suite. La finalisation Stripe côté serveur relit le PaymentIntent auprès de Stripe ; elle passe aussi par cette suite.
2. `markFinalAndDispatch` appelle d'abord `pointsKV2Settlement.prepare`. Pour une commande sans `order_metadata.erpnextPointsK`, cet appel ne fait rien : Link Pay, QR Pay, paiements marchands et anciennes recharges restent inchangés.
3. La preuve prestataire (prestataire, référence, montant en unités mineures, devise, tentative, événement) est enregistrée une seule fois par commande. Une même Payment Request, un même Sales Order ou une même référence prestataire ne peuvent pas être réglés par deux commandes.
4. Lecture et contrôle sur le site ERPNext de la commande : Customer (`alias` = identifiant Keycloak de l'acheteur), Quotation soumise, Sales Order soumis issu de cette Quotation, Payment Request soumise sur ce Sales Order. Montant prestataire = `grand_total` de la Payment Request = total à payer de la Quotation et du Sales Order (`rounded_total`, ou `grand_total` si l'arrondi est désactivé). Une seule ligne d'article, celle de `itemCode`, avec une quantité entière et `conversion_factor = 1`.
5. Sales Invoice : retrouvée par `Sales Invoice Item.sales_order` (brouillon compris) ou créée par le mappeur natif `erpnext.selling.doctype.sales_order.sales_order.make_sales_invoice`, contrôlée, puis soumise.
6. Payment Entry : retrouvée par `reference_no` = référence prestataire et `party`, ou créée par `erpnext.accounts.doctype.payment_entry.payment_entry.get_payment_entry` sur la Sales Invoice, avec `bank_account` = `payment_account` et `mode_of_payment` de la Payment Request, `reference_no` = référence Stripe/pawaPay, et `references[].payment_request` = la Payment Request. Elle est contrôlée (montant, imputation unique et complète sur la facture), puis soumise. Avant création, la facture doit encore devoir exactement le montant encaissé.
7. Le statut de la Payment Request est relu et journalisé. Il n'est jamais forcé : c'est ERPNext qui le met à jour à la soumission du Payment Entry.
8. Dans la transaction de finalisation de la commande, le handler choisi par `item_code` (`points_k`, seul handler) crédite **la quantité de la ligne de Quotation** sur le compte K de l'acheteur (`confirmPointsAcquisition` : lot, KLOT, quatre écritures K, outbox `PointsAcquisitionCompleted`). Le TTC et le montant en devise ne servent jamais de nombre de K. La valeur économique du lot est le montant HT de la ligne.

## Contrat attendu du flux 2

La commande de paiement est une `api_payment_orders` existante, `order_purpose = 'wallet_recharge'`, gelée par le checkout existant (Stripe ou pawaPay), avec :

```json
{
  "erpnextPointsK": {
    "version": 1,
    "site": "EUROPE",
    "customer": "CUST-00042",
    "quotation": "SAL-QTN-2026-00007",
    "salesOrder": "SAL-ORD-2026-00007",
    "paymentRequest": "ACC-PRQ-2026-00007",
    "itemCode": "POINTS-K",
    "quantityK": 83
  }
}
```

`site` est la clé `MARKETPLACE_FRAPPE_<SITE>_*` du site routé. `quantityK` est facultatif : s'il est présent, il doit être égal à la quantité de la Quotation. Le montant attendu de la tentative prestataire doit être le `grand_total` de la Payment Request en unités mineures.

## Configuration

`ERPNEXT_ITEM_HANDLERS` (JSON) associe un `item_code` ERPNext à un handler métier, par exemple `{"POINTS-K":"points_k"}`. Sans cette entrée, la confirmation prestataire reste enregistrée (`payment_provider_events`, non traité), mais rien n'est facturé ni crédité ; le webhook répond 500 et l'événement est rejoué par le prestataire et par la boucle de reprise.

## Reprise et idempotence

- Un événement Stripe/pawaPay répété, un second événement pour le même paiement, un appel de réconciliation pawaPay ou la boucle de reprise du worker outbox (`outbox-dispatcher.ts`, commandes `wallet_recharge` payées sans acquisition terminée) rappellent `markFinalAndDispatch`. Chaque étape reprend où le journal s'est arrêté.
- Panne entre facture et paiement : la facture soumise est retrouvée ; un brouillon laissé par une panne avant soumission est retrouvé puis soumis.
- Panne entre comptabilité et crédit K : le journal est à `payment_entry_submitted` ; la reprise crédite sans aucun appel d'écriture ERPNext.
- Deux livraisons simultanées : un bail de 120 s sur la ligne du journal sérialise les appels ERPNext. Le crédit K est protégé par les verrous de commande et d'acquisition existants.
- Les triggers rendent l'identité du journal, les documents ERPNext enregistrés, la quantité K et la transaction K immuables ; les étapes sont en ajout seul. `k_credited` exige l'acquisition K de la même quantité.

## Limites vérifiées et préconditions

- Les tests utilisent une base PostgreSQL jetable (`konektag_test`, migrations 001 à 234), les vraies routes de webhook avec signatures Stripe et pawaPay valides, et un double HTTP ERPNext. Aucun site Frappe, aucun prestataire réel, aucune transaction réelle.
- Le double reproduit le comportement ERPNext v15 : un Payment Entry dont la ligne porte `payment_request` réduit le restant dû de la Payment Request et la passe à `Paid`. Il faut le confirmer sur un site ERPNext de TEST avant la recette KON-72. Si la version installée ne le fait pas, le journal enregistre `payment_request_reflected:pending` et le statut ERPNext réel, sans le forcer.
- Le nom du champ `Customer.alias` vient du cadrage du flux 1 (KON-68) ; il est à confirmer avec sa livraison.
- Le registre K refuse une entité juridique non `APPROVED` (trigger `derive_v3_gl_scope`). Dans une base neuve, `KTG-CG` est `PENDING_APPROVAL` : un achat CG serait alors facturé et réglé dans ERPNext, mais le crédit K attendrait. Il faut vérifier ce statut sur l'environnement visé.
- Les confirmations `manual` (approbation administrateur) ne règlent pas un achat V2 : il faut une preuve Stripe ou pawaPay.

Validation : `DATABASE_URL=postgres://…/konektag_test NODE_ENV=development npx vitest run --config tests/integration/vitest.config.ts points-k-v2`, et `npx vitest run tests/unit/points-k-v2-settlement.test.ts`.
