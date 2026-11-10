# Suivi Réseau des opérations dès leur émission

Les équipes Réseau (Europe, Congo, Liban) voient chaque opération dans Frappe (`Konektag Network Operation`, app
`konektag_360`) dès son émission, paiement encore en attente, puis la même ligne passe à « Payé » ou « Échoué ».

| Opération | Clé | Site Réseau | « En attente de paiement » | « Payé » / « Échoué » |
|---|---|---|---|---|
| Link Pay | `link-pay:<ID du lien>` | site Réseau du lien (`network_site`) | émission du lien (`networkLinkService.create`) | webhook Réseau existant `link_pay.payment.succeeded`, puis notification du site marchand ; une seule livraison si Réseau et marchand sont le même site |
| Recharge Points K | `recharge:<ID de la tentative API>` | site Konektag du pays de résidence, figé sur la commande (`order_metadata.konektagSite`) | PawaPay : page de paiement acceptée (`depositId`) ; Stripe : PaymentIntent créé (`pi_…`) | webhook vérifié Stripe ou PawaPay, ou rapprochement PawaPay existant si le webhook manque |

Le site d'une recharge n'est jamais fixé dans le code : FR/BE → `konektag-fr` → EUROPE, CG → `konektag-cg`, LB → `konektag-lb`
(voir `frappe-site-routing.md`). Les tentatives hors achat de Points K routé (checkout marchand, ancienne recharge) n'en créent pas.

## Fiabilité

- Chaque notification est un événement d'outbox `NetworkOperationChanged`, écrit dans la transaction qui change
  l'opération ; le worker l'envoie au site avec son compte de service (`konektag_360.network_operations.record`), avec les
  reprises et le dead-letter existants.
- `aggregate_ref` = clé de notification (`…:issued`, `…:pending`, `…:paid`, `…:failed`), unique (migration 232) : un
  webhook ou un rapprochement rejoué n'ajoute aucun événement.
- Frappe applique chaque notification une fois. Un statut final peut arriver en premier et créer la ligne ; une
  émission tardive ne la repasse jamais en attente (elle complète seulement les champs vides) ; le premier statut final reste.
- Les montants en attente restent hors des soldes à verser et des versements : ceux-ci ne lisent que
  `Link Pay Network Transaction`, créée au paiement. Aucune écriture de règlement côté API n'est ajoutée.

## Déploiement

1. Migration 232 **avant** le code : sans l'index, l'émission d'un lien échouerait (`ON CONFLICT` sans index).
2. Release `konektag_360` (DocType, rôle `Konektag Network API`).
3. Rôle `Konektag Network API` aux comptes de service des sites Konektag (EUROPE, KONEKTAG_CG, LIBAN) ; les comptes
   `Link Pay API` des sites Réseau Link Pay sont déjà acceptés.

## Recette

`konektag_360/scripts/validate-link-pay-e2e.sh <konektag-api>` : vraie API, PostgreSQL jetable, sites Frappe jetables
congo.test (Réseau) et resto.test (marchand), vrai worker d'outbox. Couvre : lien visible en attente puis payé sur la même
ligne (sites distincts et site commun), paiement reçu avant l'émission, rejeu d'événement, recharge PawaPay par webhook et
par rapprochement (échec), recharge Stripe échouée.
