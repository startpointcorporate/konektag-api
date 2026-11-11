# KON-74 — Correction des unités monétaires Points K

## Contrat

ERPNext conserve ses montants en devise : un devis, Sales Order et Payment Request de 12 EUR restent à 12 EUR.
Seul l'ordre API PostgreSQL est représenté par un entier en unités mineures : 1200, amount_unit=MINOR.
Stripe reçoit 1200 centimes pour 12 EUR ; pawaPay reçoit 8567 pour 8567 XAF.
Aucune donnée ou configuration ERPNext n'a été modifiée par ce correctif.

## Défaut et correction

Le flux 2 convertissait le TTC en unités mineures, puis l'insertion omettait amount_unit.
La valeur PostgreSQL par défaut MAJOR faisait reconvertir les centimes en unités mineures une deuxième fois.
La création Points K transmet et persiste maintenant MINOR explicitement, avec validation de l'unité.
Les autres appels historiques de recharge conservent MAJOR par défaut.
Un ordre ERPNext historique marqué MAJOR est refusé avant financement ; aucun historique n'est réécrit automatiquement.
La préparation conserve le TTC natif : pas de seconde TVA historique ni de frais supplémentaires ajoutés au Payment Request ERPNext.
Pour les autres flux, la politique existante est conservée et les frais proportionnels Stripe utilisent la bonne unité du principal.

## Preuves locales

PostgreSQL 17 jetable dédié, base konektag_test, migrations versionnées 001 à 233 appliquées.
Test du vrai createPointsKCheckout, de la vraie insertion createWalletRechargeOrder et de la vraie préparation du financement.
Les documents ERPNext sont des fixtures explicites ; ce test n'est pas une recette ERPNext réelle.
La route Stripe create-intent est exécutée avec capture locale des arguments SDK : aucun appel à Stripe.
Les notifications de tentative et Redis sont neutralisées dans ce test isolé.

| TTC ERPNext | PostgreSQL | Montant attendu prestataire |
|---|---|---|
| 4,80 EUR | 480 MINOR | Stripe 480 |
| 12 EUR | 1200 MINOR | Stripe 1200 |
| 99,60 EUR | 9960 MINOR | Stripe 9960 |
| 12,21 USD | 1221 MINOR | conversion technique Stripe 1221, sans autoriser un rail CB au Liban |
| 8567 XAF | 8567 MINOR | pawaPay 8567 |

Le test USD vérifie l'unité technique uniquement ; le mode natif de la fixture Liban reste Wire Transfer.
Six tests PostgreSQL réussis, incluant la compatibilité d'une recharge historique et le refus des anciens ordres ambigus.
Sur le code avant correctif : cinq cas échouent (MAJOR au lieu de MINOR) et le cas historique réussit.
Les tests unitaires couvrent aussi les unités invalides et la proportion Stripe : 1200 centimes + 3 % = 1236 centimes, pas 4800.

Commande de reproduction sur une base jetable konektag_test migrée :

```sh
DATABASE_URL=postgresql://postgres@127.0.0.1:55474/konektag_test NODE_ENV=development \
  npx vitest run --config tests/integration/vitest.config.ts points-k-money
```

## Limites

Ni paiement réel ni PaymentIntent distant créé. Aucune clé prestataire réelle utilisée.
Aucune migration ou modification de données de production. Le correctif doit être livré avant reprise du financement.
La recette de bout en bout et le règlement/crédit KON-71 restent à valider séparément.
