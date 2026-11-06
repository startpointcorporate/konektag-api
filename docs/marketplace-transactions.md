# Transactions Marketplace — commande Restaurant et réservation Hôtel (#25)

Ces opérations complètent la lecture Marketplace de #24. Le navigateur appelle `konektag-web`, qui relaie côté serveur vers ces routes. Seul `konektag-api` connaît les sites Frappe et leurs identifiants de service.

| Opération | Route | Frappe |
| --- | --- | --- |
| Revalider un panier | `POST /api/public/marketplace/merchants/{slug}/restaurant/quote` | lecture `POS Profile`, `Price List`, `Item`, `Item Price`, `Item Group` |
| Commander | `POST /api/public/marketplace/merchants/{slug}/restaurant/orders` | `lumen_restaurants.api.restaurant.open_order` puis `save_order` |
| Disponibilités | `GET /api/public/marketplace/merchants/{slug}/hotel/availability` | lecture `Hotel Room Type`, `Hotel Room`, `Hotel Reservation` |
| Réserver | `POST /api/public/marketplace/merchants/{slug}/hotel/reservations` | insertion `Guest` (si nouveau) et `Hotel Reservation` |

Les contrats complets (corps, réponses, erreurs) sont décrits dans `docs/openapi.yaml`.

## Résolution du site

`MARKETPLACE_TRANSACTION_MERCHANTS` associe un slug public à ses capacités et à une clé de site (`RESTODEMO`, `HOTELDEMO`). Les identifiants de chaque site sont lus dans `MARKETPLACE_FRAPPE_<SITE>_URL`, `_API_KEY` et `_API_SECRET`. Le client ne choisit jamais le site, l'outlet ni la réception. Une capacité absente renvoie `404 CAPABILITY_NOT_AVAILABLE` sans appel à Frappe. Une fois la projection de #24 livrée, une capacité doit aussi y être publiée pour être active.

## Garanties

- **Prix et devise** : relus à chaque appel dans la liste de prix de l'outlet, avec les seules lignes `Item Price` en vigueur, comme le fait `price_books.get_price_map` dans Lumen. Le plat doit être vendable, actif, sans variantes et appartenir aux sections de l'outlet. Un écart déclenche `409 PRICE_CHANGED` avec le devis à jour. Aucune commande n'est créée dans ce cas.
- **Rejeu Restaurant** : la clé `Idempotency-Key` est enregistrée par Lumen (`order_id`, avec `app_type` = canal). Un rejeu retrouve la commande même si le cache Redis est perdu. Une commande ouverte par une tentative interrompue est complétée, jamais dupliquée.
- **Rejeu Hôtel** : la clé est conservée 7 jours dans Valkey. Si une tentative a été coupée après l'écriture, la reprise recherche la réservation du même client pour le même type de chambre et les mêmes dates avant de réserver.
- **Disponibilité** : recalculée au moment de la réservation. Les réservations Konektag d'un même type de chambre sont sérialisées. Hospitality revalide la chambre à l'insertion (`HotelReservation.validate`). Une chambre perdue entre la recherche et la validation renvoie `409 ROOM_UNAVAILABLE` avec les disponibilités à jour.
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
1. `Hotel Reservation` n'a pas de référence externe unique. Le rejeu repose sur Valkey et sur la recherche client/dates. Attendu : champ `external_reference` unique, renseigné à la création.
2. `check_availability` lit puis insère sans verrou. Deux créations simultanées hors Konektag (Desk + Web) peuvent passer. Attendu : verrou `SELECT … FOR UPDATE` sur la chambre (`Hotel Room`) dans `validate`, comme `open_order` le fait pour les tables Lumen.
3. `POS Restaurant Order.order_id` n'est pas unique. Le rejeu est sûr pour Konektag (lecture puis verrou), mais pas garanti en base. Attendu : index unique `(app_type, order_id)`.

## Recette DESIGN

Aucune recette ne touche la production. Les références de test sont relevées dans Lumen (*POS Restaurant Order*) et Hospitality (*Hotel Reservation*).

1. Restaurant : commander depuis la fiche, retrouver `ORD-…` dans Lumen, rejouer le même envoi (même clé) et vérifier qu'il n'existe qu'une commande `order_id = <clé>`. Modifier un prix dans Frappe, puis vérifier le `409 PRICE_CHANGED`.
2. Hôtel : rechercher, réserver, retrouver `HR-…` dans Hospitality. Réserver la dernière chambre depuis le Desk entre la recherche et la validation, puis vérifier le `409 ROOM_UNAVAILABLE`.
