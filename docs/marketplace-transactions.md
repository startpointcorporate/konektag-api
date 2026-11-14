# Transactions Marketplace — commande Restaurant et réservation Hôtel (#25)

Ces opérations complètent la lecture Marketplace de #24. Le navigateur appelle `konektag-web`, qui relaie côté serveur vers ces routes. Seul `konektag-api` connaît les sites Frappe et leurs identifiants de service.

| Opération | Route | Frappe |
| --- | --- | --- |
| Fiche publiée (#24) | `GET /api/public/marketplace/merchants/{slug}` | aucun : projection PostgreSQL |
| Menu | `GET …/restaurant/menu` | lecture `POS Profile`, `Price List`, `Item`, `Item Price`, `Item Group` |
| Chambres | `GET …/hotel/rooms` | lecture `Hotel Room Type`, `Hotel Room` |
| Revalider un panier | `POST /api/public/marketplace/merchants/{slug}/restaurant/quote` | lecture `POS Profile`, `Price List`, `Item`, `Item Price`, `Item Group` |
| Commander | `POST /api/public/marketplace/merchants/{slug}/restaurant/orders` | `lumen_restaurants.api.restaurant.open_order` puis `save_order` |
| Disponibilités | `GET /api/public/marketplace/merchants/{slug}/hotel/availability` | lecture `Hotel Room Type`, `Hotel Room`, `Hotel Reservation` |
| Réserver | `POST /api/public/marketplace/merchants/{slug}/hotel/reservations` | insertion `Guest` (si nouveau) et `Hotel Reservation` |
| Demander une table | `POST /api/public/marketplace/merchants/{slug}/restaurant/reservation-requests` | `konektag_360.booking.api.submit` en invité → `POS Table Reservation` Lumen (`Online`, `Requested`) |

Les contrats complets (corps, réponses, erreurs) sont décrits dans `docs/openapi.yaml`.

## Résolution du site

`MARKETPLACE_TRANSACTION_MERCHANTS` associe un slug public à ses capacités et à une clé de site (`RESTODEMO`, `HOTELDEMO`). Les entités Konektag (`konektag-fr`, `konektag-cg`, `konektag-lb`) y portent un `site` au niveau du slug : voir [frappe-site-routing.md](frappe-site-routing.md). Les identifiants de chaque site sont lus dans `MARKETPLACE_FRAPPE_<SITE>_URL`, `_API_KEY` et `_API_SECRET`. Le client ne choisit jamais le site, l'outlet ni la réception. Une capacité absente renvoie `404 CAPABILITY_NOT_AVAILABLE` sans appel à Frappe. Une capacité n'est active que si elle est **aussi publiée** dans la projection Marketplace. Une fiche absente, dépubliée ou sans cette capacité renvoie `404 CAPABILITY_NOT_AVAILABLE`, sans appel Frappe. Si la projection est injoignable, la réponse est `503 PROFILE_SOURCE_UNAVAILABLE` : l'API refuse plutôt que de laisser passer.

## Projection Marketplace (#24) — contrat livré

**Contrat (livré par konektag_360, branche `feat/13-publication-worker`, PR konektag_360#17).** Le worker de publication écrit directement dans la table de la migration `228_marketplace_published_establishments.sql`, reprise à l'identique comme fixture de ses tests. Sur la base `konektag`, la migration est enregistrée APPLIED avec le checksum `92fb4026…a032ef0`, identique au fichier de cette branche : **ce fichier ne doit plus changer d'un octet**. Toute évolution passera par une nouvelle migration.

- Écriture : UPSERT paramétré conditionnel, version strictement croissante, même `source_site`, verrou consultatif par établissement. Rejeu identique sans effet, version ancienne ignorée, même version avec un autre contenu refusée. Dépublication : ligne conservée, `snapshot` NULL et capacités vides.
- `snapshot` : `konektag_360.domain.snapshot()` du job ; il contient aussi `capabilities`. L'API se fie uniquement à la colonne `capabilities`.
- `capabilities` : fixées côté serveur Frappe par établissement (`konektag_360_publication_capabilities`), sous-ensemble de `{restaurant, hotel}`.
- Compte d'écriture dédié : SELECT/INSERT/UPDATE sur cette seule table, sans DELETE. L'API lit seule la table, en `SELECT`. Les médias `/files/…` sont servis depuis `https://<source_site>`.

La fonction `docs/proposals/marketplace-apply-publication.sql` **n'a pas été retenue** : elle n'est ni appliquée ni nécessaire. Elle n'est conservée que parce que le commentaire de la migration 228, déjà appliquée, y renvoie.

**Validation.** `npm run test:marketplace:pg` exécute `tests/integration/marketplace-projection.pg.ts` contre une base jetable `konektag_test` désignée par `MARKETPLACE_PG_TEST_URL`. Ce test est hors de la suite par défaut, qui doit tourner sans service externe ni test sauté. Le 7 novembre 2026, la requête exacte de l'API a été rejouée en transaction lecture seule sur la vraie ligne de Restaurant Démo, puis convertie par `toPublicProfile` : fiche retrouvée par son slug, capacité `restaurant` reconnue, `hotel` non.

Le menu et les chambres restent lus en direct dans Lumen et Hospitality, avec un cache de 60 s. Ce sont les mêmes règles que celles de la validation de commande : un plat affiché est un plat accepté à son prix. Ce choix est à valider en revue : il évite une seconde projection des catalogues.

## Garanties

- **Prix et devise** : relus à chaque appel dans la liste de prix de l'outlet, avec les seules lignes `Item Price` en vigueur, comme le fait `price_books.get_price_map` dans Lumen. Le plat doit être vendable, actif, sans variantes et appartenir aux sections de l'outlet. Un écart déclenche `409 PRICE_CHANGED` avec le devis à jour. Aucune commande n'est créée dans ce cas.
- **Rejeu Restaurant** : la clé `Idempotency-Key` est enregistrée par Lumen (`order_id`, avec `app_type` = canal). Un rejeu retrouve la commande même si le cache Redis est perdu. Une commande ouverte par une tentative interrompue est complétée, jamais dupliquée.
- **Rejeu Hôtel** : la clé est conservée 7 jours dans Valkey, avec une marque « écriture en cours » posée juste avant l'insertion dans Hospitality. Une réservation n'est jamais retrouvée par client, type de chambre et dates : un tel rapprochement peut renvoyer la réservation d'un autre. Si une tentative a été coupée pendant l'écriture, la reprise interroge le champ unique `externalReferenceField` de *Hotel Reservation*, où la clé est enregistrée. Sans ce champ, l'API renvoie `409 RESERVATION_OUTCOME_UNKNOWN` et ne réserve plus avec cette clé. Un refus net de Frappe (validation, chambre prise) lève la marque : la nouvelle tentative est sûre.
- **Disponibilité** : recalculée au moment de la réservation. Les réservations Konektag d'un même type de chambre sont sérialisées. Hospitality revalide la chambre à l'insertion (`HotelReservation.validate`). Une chambre perdue entre la recherche et la validation renvoie `409 ROOM_UNAVAILABLE` avec les disponibilités à jour.
- **Taille des corps** : 2 Mio (2 097 152 octets) au plus pour le devis, la commande et la réservation. Le plafond porte sur les octets réellement lus, avec ou sans `Content-Length`. Au-delà, la réponse est `413 PAYLOAD_TOO_LARGE`, avant le parsing JSON et tout appel à Frappe. Les schémas bornent ensuite chaque champ et chaque quantité. Le relais Web (konektag-web#51) limite encore les corps à 16 000 caractères.
- **Erreurs** : les messages Frappe ne sont jamais transmis, car ils peuvent citer d'autres clients. Sans Valkey, les écritures sont refusées (`503`).

## Demandes de table Restaurant (#50)

Contrat attendu par le formulaire « Demander une réservation » (konektag-web#51, commit `5806932`) et adaptateur Frappe de konektag_360 (`docs/features/RESTAURANT_BOOKING_API.md`).

**Activation sur la fiche.** `GET …/merchants/{slug}` renvoie `reservationRequests: {enabled, confirmation: "manual"}`. `enabled` vaut `true` seulement si quatre conditions sont réunies : la fiche est publiée ; elle porte la capacité `restaurant` ; le snapshot konektag_360 contient `reservation: {enabled: true, mode: "request"}` ; la capacité `restaurant` du slug est routée par `MARKETPLACE_TRANSACTION_MERCHANTS`. L'activation reste celle de Frappe (`configure`, page native avec `auto_confirm=0`). L'API n'a pas de second interrupteur.

**Envoi.** `POST …/restaurant/reservation-requests`, avec un `Idempotency-Key` obligatoire. Corps : `name`, `phone` (E.164), `date` (`YYYY-MM-DD`), `time` (`HH:mm`), `partySize` (1–50), `comment` facultatif (≤ 500), `website` (honeypot, vide). Date et heure s'entendent dans le fuseau du restaurant.
- Le site vient du routage serveur. L'établissement est résolu par Frappe depuis le slug. Le `source_site` de la projection doit être l'hôte du site routé, sinon l'API répond `503` sans rien envoyer.
- L'appel est fait en **invité**, sans le jeton de service des commandes, comme le demande konektag_360.
- `201 {reference, status, replayed:false}` pour une nouvelle demande, `200 {…, replayed:true}` pour un rejeu. `reference` est le nom du document `POS Table Reservation` affiché dans Lumen. `status` est celui que renvoie Frappe.
- Erreurs : `404 CAPABILITY_NOT_AVAILABLE` (non publiée, désactivée, page native retirée), `409 SLOT_UNAVAILABLE` (créneau complet, passé, hors grille, jour fermé, hors horizon), `422 PARTY_SIZE_NOT_ACCEPTED`, `422 INVALID_REQUEST`, `422 IDEMPOTENCY_KEY_REUSED`, `429 TOO_MANY_REQUESTS`, `502 REQUEST_NOT_RECORDED` (aucune référence renvoyée), `503 RESERVATIONS_UNAVAILABLE` (méthode fermée par le site, par exemple le filtre de démo) ou `SITE_UNAVAILABLE`.

**Rejeu.** L'API dérive de la clé une `request_key` déterministe (SHA-256, 64 caractères hexadécimaux). konektag_360 l'enregistre avec l'empreinte du contenu, dans la même insertion que la ligne native. Même clé et même contenu : même référence, y compris après perte de la réponse ou du cache Valkey. Même clé avec un autre contenu : refus. L'API ne met aucun résultat en cache : un rejeu interroge toujours Lumen.

**Limites connues.**
- Lumen et konektag_360 limitent par IP : 60 envois par heure et 15 demandes en ligne par jour. Appelés depuis l'API, tous les visiteurs partagent son IP de sortie. L'API ajoute ses propres limites (par pair, par restaurant, et 5 par téléphone et par heure), mais une propagation fiable de l'IP du visiteur reste à convenir avec konektag_360 et Web.
- Au rejeu, `submit` renvoie toujours `status: "Requested"`, même si le restaurant a confirmé ou annulé la demande depuis.
- Les refus Lumen sont reconnus par leur message en anglais (`Accept-Language: en`). Un message inconnu donne `422 INVALID_REQUEST`.

## Prérequis Frappe (suivi dans konektag_360#14)

Un utilisateur de service dédié par site, avec une clé API, sans accès Desk.

**restodemo.konektag.eu (Lumen)**
- Assigné à l'outlet (`POS Profile` → Applicable for Users), outlet en mode restaurant (`lumenpos_restaurant_mode`).
- Capacité Lumen « Open a table order », droits lecture/écriture sur `POS Restaurant Order`, lecture sur `POS Profile`, `Price List`, `Item`, `Item Price` et `Item Group`.
- Ligne `delivery_apps` dans *LumenPOS Settings* nommée comme le canal (`Konektag` par défaut), avec la liste de prix de l'outlet. Sinon la caisse refuse d'encaisser la commande (`Unknown delivery app`).

**hoteldemo.konektag.eu (Hospitality)**
- Lecture sur `Hotel Room Type`, `Hotel Room`, `Hotel Reservation` et `Guest`, création sur `Guest` et `Hotel Reservation`. La création d'une réservation ouvre aussi un `Guest Folio` provisoire (`ignore_permissions` côté Hospitality).

**Manques Frappe signalés**
0. ~~Projection Marketplace~~ : livrée (worker konektag_360 actif sur restodemo uniquement, capacités publiées). Il reste, pour les commandes : le compte de service API restodemo et la ligne `delivery_apps` « Konektag » dans *LumenPOS Settings*.
1. `Hotel Reservation` n'a pas de référence externe unique. **Bloquant pour la reprise après coupure** : sans ce champ, une tentative interrompue pendant l'écriture renvoie `RESERVATION_OUTCOME_UNKNOWN`. Attendu : champ Data unique (par exemple `konektag_reference`), accepté à la création par le compte de service. Il faut ensuite déclarer `"externalReferenceField":"konektag_reference"` dans la capacité `hotel`.
2. `check_availability` lit puis insère sans verrou. Deux créations simultanées hors Konektag (Desk + Web) peuvent passer. Attendu : verrou `SELECT … FOR UPDATE` sur la chambre (`Hotel Room`) dans `validate`, comme `open_order` le fait pour les tables Lumen.
3. `POS Restaurant Order.order_id` n'est pas unique. Le rejeu est sûr pour Konektag (lecture puis verrou), mais pas garanti en base. Attendu : index unique `(app_type, order_id)`.

## Recette DESIGN

Aucune recette ne touche la production. Les références de test sont relevées dans Lumen (*POS Restaurant Order*) et Hospitality (*Hotel Reservation*).

1. Restaurant : commander depuis la fiche, retrouver `ORD-…` dans Lumen, rejouer le même envoi (même clé) et vérifier qu'il n'existe qu'une commande `order_id = <clé>`. Modifier un prix dans Frappe, puis vérifier le `409 PRICE_CHANGED`.
2. Hôtel : rechercher, réserver, retrouver `HR-…` dans Hospitality. Réserver la dernière chambre depuis le Desk entre la recherche et la validation, puis vérifier le `409 ROOM_UNAVAILABLE`.

## Modes de commande et association à une réservation

Les nouveaux clients envoient `orderMode: pickup | reservation` à `POST …/restaurant/orders`. Le mode réservation exige `reservationToken`, obtenu par `POST …/restaurant/reservations/lookup` avec exactement `{reference}` ou `{phone}` E.164. La décision produit accepte la recherche sans preuve de possession du téléphone ; une référence séquentielle n'est pas un secret. Les réponses sont limitées à référence/date/heure/convives et au jeton opaque de sélection.

Le menu retourne `orderModes.pickup.{enabled,available}` et `orderModes.reservation.enabled`. `enabled` représente l'offre ; `available` inclut ouverture actuelle. L'adapter K360 applique les horaires généraux (intervalles multiples/overnight, fuseau site). Sans horaires, l'activation suffit. Aucun créneau dédié n'est ajouté. Sans adapter installé, menu conservé et options désactivées ; un corps historique sans mode continue l'ancien chemin.

Les modes explicites passent exclusivement par `konektag_360.marketplace_orders.api.checkout` : prix revalidés serveur, association et création atomiques, clé unique et empreinte persistantes. Le jeton AES-GCM utilise la clé `DATA_ENCRYPTION_KEY` existante et expire après 15 minutes pour les nouvelles écritures. Il reste déchiffrable pour construire l'empreinte d'un rejeu durable après expiration/effacement du cache ; l'adapter interdit toute nouvelle création avec `selection_valid=false`. Changement de mode, réservation ou contenu sous même clé = conflit. Le rejeu relit le statut natif, sans rouvrir une commande annulée. Après refus prix/article, l'API joint un devis frais si le serveur de prix est disponible.

### Validation marchand et lien client

L'acceptation Desk est distincte du statut natif. Après acceptation, K360 génère un secret de partage 256 bits conservé chiffré (empreinte unique pour recherche), valable 7 jours. Les URLs `sms:` et WhatsApp permettent au marchand de partager depuis ses applications existantes ; aucun SMS automatique n'est envoyé.

`GET …/restaurant/orders/{token}` retourne la commande acceptée minimale, sans coordonnées/nom/note du client. Le QR est une URL native `/app/pos-restaurant-order/{reference}` sur le site routé serveur ; elle utilise l'authentification Frappe et les droits POS habituels. Tokens invalides/expirés, commandes non acceptées/annulées/rejetées renvoient le même 404. Réponses `no-store`, `no-referrer`, `noindex` ; aucun journal applicatif ajouté. Les journaux d'accès de l'infrastructure doivent être vérifiés séparément avant usage réel : le token dans l'URL n'est pas automatiquement masqué par ces en-têtes.

### Prérequis de release

1. Livrer le patch additif K360 (champs/index/hooks/adapter), configurer `konektag_360_marketplace_order_users` avec le compte de service existant et ses droits POS. Sur restodemo, identité vérifiée en lecture seule : `api-konektag@restodemo.konektag.eu`.
2. Configurer `konektag_marketplace_public_url` HTTPS côté Frappe pour la page Web ; activer explicitement `restaurant_pickup_enabled` sur l'établissement si offert. Défaut désactivé.
3. Garder les credentials `MARKETPLACE_FRAPPE_*` et `DATA_ENCRYPTION_KEY` existants stables. Aucune migration PostgreSQL API ; ne pas changer la clé de chiffrement durant les reprises de commandes.
4. Publier API puis Web après validation humaine du paquet. Aucune action production n'est effectuée par cette implémentation. La recette cible autorisée est en production avec données synthétiques dédiées, après autorisation de déploiement distincte.

Tests de contrat interlangages : `tests/contracts/export-k360-order-fixture.py` exporte les réponses des vraies fonctions Python via leur harness de tests (base/POS simulés). `marketplace-k360-contract.test.ts` les consomme dans les routes HTTP API ; ceci ne remplace pas la recette sur site déployé.
