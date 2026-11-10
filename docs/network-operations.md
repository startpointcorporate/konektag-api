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

## Statuts

| Statut | Quand |
|---|---|
| En attente de paiement | lien émis ; page PawaPay acceptée ou PaymentIntent Stripe créé |
| Payé | webhook vérifié, rapprochement PawaPay, vérification à la demande, ou paiement confirmé par un opérateur ; date = date effective du paiement |
| Échoué | idem, recharges seulement |
| Expiré | lien Link Pay non payé à son échéance (affichée sur la fiche) ; un paiement effectué dans les délais et confirmé tard le fait encore passer à Payé |

Les opérations en attente ou expirées restent hors des soldes et des versements (`Link Pay Network Transaction` seule).
Liens déjà émis au 2026-11-10 en production : aucun lien Réseau, aucune recharge, aucune tentative — pas de reprise de données.

## « Régulariser » depuis la fiche Opération Réseau

Une seule action. L'écran affiche la source, le compte prestataire, la référence, le montant, l'état API, l'échéance et
les options que l'API autorise pour l'opération, son état, ce Réseau et l'utilisateur (avec le motif des options indisponibles).

| Option | Qui | Effet |
|---|---|---|
| Vérifier le statut du paiement | lecteurs Réseau (`Link Pay Manager`, `Link Pay Approver`, `Accounts Manager`, `Konektag Payment Admin`, `Konektag Network Regularizer`, `System Manager`) | interroge la source qui fait autorité ; un résultat final est appliqué par le traitement existant (même chemin que le webhook) ; en cours, indéterminé ou source indisponible : résultat affiché, statut conservé |
| Enregistrer un paiement confirmé | `Konektag Network Regularizer` | motif (10 caractères au moins) et justificatif obligatoires ; l'API contrôle la référence, le montant, la devise et l'empreinte SHA-256 du fichier ; recharge : finalisation existante, Points K crédités une fois ; Link Pay : transaction Réseau rattachée et site marchand notifié (livraisons Link Pay) — seulement si l'API a enregistré le paiement |
| Enregistrer un échec confirmé | `Konektag Network Regularizer` | recharges seulement ; même contrôle du justificatif ; transition vers Échoué et réouverture du checkout existante |

Sources par opération :

| Opération | Source | Compte |
|---|---|---|
| Recharge PawaPay | dépôt PawaPay (`GET /v2/deposits/{depositId}`) | configuration de la tentative (`providerConfigurationKey`), sinon PawaPay par défaut |
| Recharge Stripe | PaymentIntent (`GET /v1/payment_intents/{id}`) | compte Stripe de la tentative (`<clé>_SECRET_KEY`) ; sans compte connu ou configuré : vérification indisponible, motif affiché |
| Link Pay | transaction Link Pay de l'API ; livraisons aux sites | — |

Contrôles côté serveur : Frappe vérifie le rôle et la lecture de l'opération ; l'API (`POST /api/integrations/frappe/network-operations`,
canal du site `X-Konektag-Frappe-Site` + jeton) vérifie que le site authentifié possède l'opération (même clé ou même site
Frappe, ex. CONGO et KONEKTAG_CG), le rôle déclaré et le justificatif. Un appel direct d'un autre site est refusé (403).
Aucune option ne lance un nouveau paiement.

Rejeux et conflits : mêmes protections que le webhook (événement prestataire `manual:<tentative>:<résultat>` ou
`verify:<PaymentIntent>:<statut>`, un crédit par commande). Même résultat déjà appliqué : « Déjà traité ». Résultat contraire
à un état final : « Conflit », état conservé. Échec technique (API ou prestataire injoignable) : « Échec temporaire »,
l'écran reste ouvert pour réessayer ; un crédit confirmé mais non terminé est aussi repris par le worker.

Journal : chaque action exécutée est tracée dans Frappe (`Konektag Network Regularization` : site, utilisateur, date,
option, motif, justificatif joint en privé et son empreinte, résultat, réponse) et dans l'API
(`konektag.network_operation_regularizations`, migration 233).

## Comptes et configuration

Comptes de service appelés par le worker (configuration réelle, 2026-11-10) :

| Site | Clé API | Compte | Rôle |
|---|---|---|---|
| congo.erp.konektag.eu | `CONGO` (Link Pay) | `link-pay-api@congo.erp.konektag.eu` | `Link Pay API` (déjà accepté) |
| congo.erp.konektag.eu | `KONEKTAG_CG` (recharges) | `api-congo@konektag.eu` | `Konektag Network API` à attribuer |
| europe.erp.konektag.eu | `EUROPE` | `api-europe@konektag.eu` | `Konektag Network API` à attribuer |
| liban.erp.konektag.eu | `LIBAN` | `api-lebanon@konektag.eu` | `Konektag Network API` à attribuer |

Opérateurs : `Konektag Network Regularizer` aux personnes habilitées de chaque Réseau (à désigner).

Canal « Régulariser » (Frappe → API) : configuré sur Congo (`konektag_link_pay_site` = CONGO, jeton, origine API). Europe
et Liban ne l'ont pas : y ajouter `konektag_link_pay_site` (EUROPE, LIBAN), `konektag_link_pay_site_token`,
`konektag_link_pay_api_origin`, et `EUROPE`, `LIBAN` dans `LINK_PAY_FRAPPE_SITES` (empreinte du jeton). Sans cela l'écran
affiche « Canal API non configuré sur ce site ».

## Limites

- XAF n'est pas une devise carte pour l'API : les résidents du Congo rechargent par PawaPay.
- Pas de rapprochement Stripe automatique : la vérification Stripe se fait à la demande.
- Les checkouts marchands, l'ancienne recharge Stripe et le Web sont hors périmètre.

## Déploiement (ordre)

1. Sauvegarde PostgreSQL, puis migrations 232 (index) et 233 (journal) : sans effet sur le code en place, obligatoires
   avant le nouveau code.
2. Release `konektag_360` (image), `migrate` des cinq sites : DocTypes, rôles, écran. Sans nouveau code API, rien n'y écrit.
3. Habilitations : `Konektag Network API` aux trois comptes ci-dessus ; vérifier les quatre comptes (rôles lus par
   `frappe.get_roles`) ; `Konektag Network Regularizer` aux opérateurs désignés ; canal Europe et Liban si voulu.
4. Activation : fusion de la PR API → CI puis déploiement automatique (`Deploy Konektag API to K3s PVC`, `workflow_run`
   sur `main`) qui écrit `/app/active-version` ; l'API et le worker d'outbox suivent ce fichier et basculent ensemble.
   Contrôle : `kubectl -n konektag-api exec deploy/konektag-api -- cat /app/active-version` (et le même sur
   `deploy/konektag-api-outbox`) = SHA fusionné ; `/livez`, `/api/internal/health`.
5. Recette depuis Frappe Congo (lecture, Vérifier sur une opération réelle).

## Recette

`konektag_360/scripts/validate-link-pay-e2e.sh <konektag-api>` : vraie API, PostgreSQL jetable, sites Frappe jetables
congo.test (Réseau) et resto.test (marchand), vrai worker d'outbox. Couvre : lien visible en attente puis payé sur la même
ligne (sites distincts et site commun), paiement reçu avant l'émission, rejeu d'événement, droits d'un opérateur Réseau
(lecture de toutes les opérations du site, rien sur l'autre site, refus sans rôle Réseau, aucune écriture), recharge
PawaPay par webhook et par rapprochement (échec), recharge Stripe réussie (frais affichés = frais appliqués, webhook
rejoué sans double crédit) et échouée ; « Régulariser » : options par site, prestataire et droits (PawaPay Congo,
Stripe EUR sur le second site), vérification payée / échouée / en cours / indisponible avec trace, paiement confirmé avec le
webhook avant, pendant et après (un crédit), échec confirmé, Link Pay régularisé sur sites distincts et commun,
expiration visible puis paiement dans les délais confirmé tard, refus hors rôle et hors site, conflit, reprise après échec technique.
