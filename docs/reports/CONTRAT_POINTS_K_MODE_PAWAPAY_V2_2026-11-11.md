# KON-75 — Points K : mode choisi, financement et dépôt direct pawaPay v2

Base : `main` @ `b5d57e4` (inclut le correctif d'unités KON-74, API #56, CI verte).
Plan de référence : document `plan-checkout-integre-2026-11-11` de KON-77.

## 1. Mode of Payment natif → prestataire (décidé côté serveur)

| Mode ERPNext exact | Pays routés | Prestataire | Méthode API |
|---|---|---|---|
| `CB` | FR | `stripe` | `card` |
| `Mobile Money` | CG | `pawapay` | `mobile_money` |
| `Virement Bancaire`, `Cash`, `Wire Transfer` | FR / LB / CG | aucun | aucune |

- `POST /api/points-k/checkout` fige dans `api_payment_orders.order_metadata.erpnextPointsK` :
  `site, customer, quotation, salesOrder, paymentRequest, itemCode, quantityK, modeOfPayment, provider, paymentMethod`.
- Une Payment Request déjà soumise avec un autre mode renvoie `409 MODE_OF_PAYMENT_MISMATCH` : le mode ne change plus.
- Virement, Cash et Wire Transfer : la Sales Order et la Payment Request natives sont créées, mais **aucun ordre API, aucun PSP et aucun crédit K automatique**.
  La réponse contient `provider: null, order: null, checkoutToken: null`.
- `GET /api/points-k/checkout` expose `provider` et `paymentMethod` pour chaque mode proposé.

## 2. Restriction appliquée dans les routes prestataires

`pointsKProvider(order)` est contrôlé dans toutes les routes qui touchent le prestataire, pas seulement dans la liste Web :
- `funding` : la sélection signée doit avoir le `provider` et le `rail` du mode (`stripe`/`stripe` ou `pawapay`/`mobile_money`) ;
- `stripe/create-intent` et l'attache du PaymentIntent : refusés pour un ordre Mobile Money ;
- `confirm` en `mobile_money`, Payment Page et dépôt direct : refusés pour un ordre CB ;
- `allowedPaymentMethods` ne contient que la méthode du mode.

Un ordre Points K sans `provider` figé (créé avant ce correctif) est refusé au financement (409). Aucun prestataire n'est deviné.
Les règles existantes restent inchangées : montant ERPNext autoritaire, unités MINOR, idempotence par Payment Request, verrou du changement de méthode pendant une tentative active, webhooks comme autorité.

## 3. Adaptateur pawaPay v2 (docs.pawapay.io/v2)

Tous les appels utilisent la `providerConfigurationKey` du corridor figée sur l'ordre.

| Appel | Contrat |
|---|---|
| `predictProvider` | `POST /v2/predict-provider` `{phoneNumber}` → `{country, provider, phoneNumber}` |
| `depositProviders` | `GET /v2/active-conf?country=COG&operationType=DEPOSIT`, lecture de `countries[].providers[].currencies[].operationTypes.DEPOSIT` |
| `createDeposit` | `POST /v2/deposits` `{depositId, payer:{type:'MMO', accountDetails:{phoneNumber, provider}}, amount:"<décimal majeur>", currency, clientReferenceId, customerMessage, metadata}` → `ACCEPTED`, `DUPLICATE_IGNORED` ou `REJECTED{failureCode}` |

L'ancien code `predictCorrespondent` et le corps v1 de `createDeposit` (jamais appelés) sont remplacés.

## 4. Nouvelles routes (Points K uniquement ; la Payment Page reste pour les autres consommateurs)

### `GET /api/pay/checkout/{token}/mobile-money/pawapay/providers`
`200 {country, currency, amount, providers:[{provider, nameDisplayedToCustomer, minAmount, maxAmount, pinPrompt, pinPromptRevivable}]}`.
La liste ne contient que les opérateurs qui peuvent encaisser ce montant.

### `POST /api/pay/checkout/{token}/mobile-money/pawapay/direct-deposit`
Corps strict `{phoneNumber, provider?}`. Le montant n'est jamais accepté du navigateur.

Ordre des opérations :
1. lire l'ordre gelé ;
2. appeler predict-provider (pays = pays de l'ordre, opérateur choisi = opérateur prédit) ;
3. lire active-conf : opérateur `OPERATIONAL`, `authType=PROVIDER_AUTH`, `minAmount`/`maxAmount` et `decimalsInAmount` respectés ;
4. créer ou reprendre la tentative (téléphone stocké en SHA-256 uniquement) ;
5. passer le checkout en `awaiting_mobile_money` ;
6. créer le dépôt.

Le PIN et l'approbation restent sur le téléphone, chez l'opérateur. Le statut final vient du callback signé ou de la réconciliation existante.

| Réponse | Cas |
|---|---|
| `201 {outcome:'awaiting_mobile_money', depositId, status, state, provider:{…pinPrompt}}` | dépôt accepté, ou `DUPLICATE_IGNORED` sur une relance |
| `400 INVALID_REQUEST` / `PHONE_NUMBER_INVALID` | corps ou numéro invalide |
| `409 PHONE_NUMBER_COUNTRY_MISMATCH`, `PAWAPAY_PROVIDER_MISMATCH`, `PAWAPAY_PROVIDER_NOT_CONFIGURED`, `PAWAPAY_PROVIDER_UNAVAILABLE`, `PAWAPAY_PROVIDER_AUTH_UNSUPPORTED`, `PAWAPAY_AMOUNT_BELOW_MINIMUM`, `PAWAPAY_AMOUNT_ABOVE_MAXIMUM`, `PAWAPAY_AMOUNT_PRECISION_UNSUPPORTED`, `PAWAPAY_DIRECT_DEPOSIT_NOT_AVAILABLE` | refus avant toute tentative |
| `409` « A payment attempt is still active » | autre téléphone, autre opérateur ou Payment Page déjà active |
| `422 PAWAPAY_DEPOSIT_REJECTED {failureCode}` | rejet synchrone : la tentative passe en `failed` et le checkout est rouvert |
| `502` / `503` | erreur pawaPay, ou configuration du corridor absente |

## 5. Limites de la recette

- Tests unitaires et de contrat uniquement : `fetch` et services injectés sont des mocks. **Aucun appel sandbox ni réel à pawaPay ou Stripe n'a été exécuté.**
- `tests/integration/points-k-money.pg.ts` a été mis à jour (Liban Wire Transfer : aucun ordre ; USD reste une assertion technique sur une route CB). Ce fichier n'est exécuté ni en local, faute de PostgreSQL, ni en CI.
- Les opérateurs `PREAUTH` et `REDIRECT_AUTH` sont refusés : aucun parcours de code d'autorisation ou de redirection n'est implémenté.
- Le callback existant compare des montants entiers. Cela convient pour XAF, seule devise pawaPay acceptée par `getMobileMoneyOrder`.
- Scénarios sandbox à exécuter en KON-72 :
  - numéro de test COMPLETED ;
  - numéro de test FAILED ;
  - montant hors limites (REJECTED `INVALID_AMOUNT`) ;
  - relance du même dépôt (`DUPLICATE_IGNORED`) ;
  - second téléphone pendant une tentative active (409) ;
  - callback répété.
