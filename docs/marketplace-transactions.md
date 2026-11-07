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

Les contrats complets (corps, réponses, erreurs) sont décrits dans `docs/openapi.yaml`.

## Résolution du site

`MARKETPLACE_TRANSACTION_MERCHANTS` associe un slug public à ses capacités et à une clé de site (`RESTODEMO`, `HOTELDEMO`). Les identifiants de chaque site sont lus dans `MARKETPLACE_FRAPPE_<SITE>_URL`, `_API_KEY` et `_API_SECRET`. Le client ne choisit jamais le site, l'outlet ni la réception. Une capacité absente renvoie `404 CAPABILITY_NOT_AVAILABLE` sans appel à Frappe. Une capacité n'est active que si elle est **aussi publiée** dans la projection Marketplace. Une fiche absente, dépubliée ou sans cette capacité renvoie `404 CAPABILITY_NOT_AVAILABLE`, sans appel Frappe. Si la projection est injoignable, la réponse est `503 PROFILE_SOURCE_UNAVAILABLE` : l'API refuse plutôt que de laisser passer.

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
