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

## Accès des équipes Réseau

Chaque site Frappe a sa propre base : un opérateur du site Congo voit toutes les opérations du Congo, en attente
comprises, et aucune d'Europe ou du Liban. Lecture : rôles `Link Pay Manager`, `Link Pay Approver`, `Accounts Manager`,
`Konektag Payment Admin` ou `System Manager`. Aucun opérateur ne peut écrire une opération : seuls les comptes de
service de l'API (`Konektag Network API`, `Link Pay API`) appellent `record`. En production le 2026-11-10 : Congo
`info-congo@` et un `Link Pay Approver` ; Europe et Liban `info-konektag@`.

## En cas d'incident

La fiche est en lecture seule : aucune action manuelle dans Frappe ne change un statut ou ne crédite des Points K.
- PawaPay : le rapprochement automatique (à chaque passage du worker) interroge PawaPay pour toute tentative en
  attente et produit la même mise à jour que le webhook.
- Stripe : Stripe rejoue lui-même un webhook non acquitté ; on peut aussi le renvoyer depuis le tableau de bord
  Stripe (même `evt_…`, sans double crédit). Il n'y a pas de rapprochement Stripe automatique : une recharge
  dont aucun webhook n'arrive reste « En attente de paiement ».
- Notification non livrée à Frappe : l'outbox reprend avec délai croissant puis dead-letter ; la réémission
  d'un événement est sans effet si Frappe l'a déjà appliqué.

## Limites

- Un lien Link Pay expiré sans paiement reste « En attente de paiement » : à distinguer d'un paiement bloqué par
  sa date d'expiration (non affichée).
- XAF n'est pas une devise carte pour l'API : les résidents du Congo rechargent par PawaPay, jamais par Stripe.
- Les checkouts marchands et l'ancienne recharge Stripe n'ont pas de ligne Réseau.

## Déploiement (ordre)

1. Sauvegarde puis migration 232 : un index seul, sans effet sur le code en place ; obligatoire **avant** le nouveau
   code (sinon l'émission d'un lien échoue sur `ON CONFLICT`).
2. Release `konektag_360` et `migrate` des sites : DocType et rôle `Konektag Network API`. Sans nouveau code API,
   rien n'y écrit encore.
3. Rôle `Konektag Network API` aux comptes `api-europe@`, `api-congo@`, `api-lebanon@` ; vérifier les rôles des trois
   comptes et du compte `Link Pay API` de Congo.
4. Fusion de la PR API : le déploiement automatique active la nouvelle version ; le worker d'outbox suit la même
   version active et bascule en même temps (quelques secondes). Si un rôle manquait, les événements restent en
   reprise dans l'outbox jusqu'à correction : aucune perte.

## Recette

`konektag_360/scripts/validate-link-pay-e2e.sh <konektag-api>` : vraie API, PostgreSQL jetable, sites Frappe jetables
congo.test (Réseau) et resto.test (marchand), vrai worker d'outbox. Couvre : lien visible en attente puis payé sur la même
ligne (sites distincts et site commun), paiement reçu avant l'émission, rejeu d'événement, droits d'un opérateur Réseau
(lecture de toutes les opérations du site, rien sur l'autre site, refus sans rôle Réseau, aucune écriture), recharge
PawaPay par webhook et par rapprochement (échec), recharge Stripe réussie (frais affichés = frais appliqués, webhook
rejoué sans double crédit) et échouée.
