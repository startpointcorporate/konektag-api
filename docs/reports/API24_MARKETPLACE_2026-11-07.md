# API #24 — lectures marketplace publiées — 2026-11-07

Contrat de référence : https://github.com/startpointcorporate/konektag-api/issues/24#issuecomment-6708223926
Consommateur : https://github.com/startpointcorporate/konektag-web/pull/52

## Contrat final pour source.ts

`GET /api/public/marketplace/merchants`

- `q` : texte libre, maximum 120 caractères, casse et accents ignorés.
- Recherche : nom, descriptions établissement/marchand/SEO, activités, produits/services si présents dans le snapshot public. Pas de correction de fautes.
- `country` : code ISO alpha-2 valide en majuscules.
- `city` : identifiant opaque renvoyé par les facettes, maximum 120 caractères.
- `activity` : activity_code, maximum 80 caractères.
- `sort` : `name` par défaut, ou `distance` ; renvoyé en écho.
- `lat` / `lng` : requis en tri distance, bornés à ±90 / ±180.
- `page` : 1 par défaut, entier de 1 à 1 000 000.
- `limit` : 24 par défaut, entier de 1 à 50.
- Filtres combinables ET, tri global et total filtré avant pagination.
- Nom : normalisation Unicode sans casse/accents et expansion œ/æ ; départage slug.
- Distance : Haversine en kilomètres (rayon terrestre 6371 km), puis nom et slug.
- Sans coordonnées : établissements conservés en fin de tri distance, par nom puis slug.
- Réponse : `{items, total, page, limit, sort}` ; total conservé même sur une page vide.
- Item : `{slug, name, seoDescription?, city?, countryCode?, activities, coordinates?, logo?, distanceKm?}`.
- `city` conserve les champs publics existants `{id?, name?, slug?}` ; activities contient `{code,name}`.
- Logo : URL publique identique à la fiche par slug.
- `coordinates` absent si coordonnées manquantes ; `distanceKm` vaut `null` dans ce cas en tri distance.
- En tri nom, `distanceKm` est absent, même si lat/lng sont fournis.

`GET /api/public/marketplace/facets`

- `{countries:[{code,count,cities:[{id,name,count}]}], activities:[{code,name,count}]}`.
- Compteurs globaux des établissements publiés, indépendants des filtres de liste.
- Activités : un établissement compté une fois par code.
- Villes homonymes distinguées par identifiant, regroupées sous leur pays.
- Identifiants pays/ville/activité absents : omission de la facette correspondante ; établissement toujours listable.

Erreurs : `422 {error:"INVALID_PARAMETERS"}` ; `503 {error:"PROJECTION_UNAVAILABLE"}`.
Aucune lecture des snapshots historiques N2/N3 ; aucune écriture ni appel Frappe.
Les slugs proviennent de la même projection que `GET /api/public/marketplace/merchants/{slug}`.

## Écarts et précisions pour Web

- Aucun renommage des routes ou paramètres demandés.
- Distance absente : `null` en tri distance ; coordonnées omises. Les champs optionnels ne sont pas inventés.
- Borne supplémentaire de pagination : page ≤ 1 000 000.
- Pas de bbox ; carte limitée aux résultats de la page courante conformément au contrat.
- Source réelle des produits/services : recherche seulement si ces champs figurent déjà dans le snapshot publié.

## Vérification et exploitation

- PostgreSQL 16 jetable, migration 228 appliquée deux fois, lecteur limité à SELECT.
- 13 tests PostgreSQL : 57 fixtures supplémentaires, 3 pages, noms/accents, départage slug, distance, filtres combinés, homonymes, SQLi, bornes, erreurs 503, dépublication et coordonnées absentes.
- Suite générale : 168 fichiers, 2739 tests réussis et 5 échecs attendus.
- Typecheck, build, génération OpenAPI et diff --check réussis.
- Replay : `MARKETPLACE_PG_TEST_URL=postgresql://USER@HOST:PORT/konektag_test npm run test:marketplace:pg` (base jetable exclusivement ; schéma konektag recréé par les tests).
- Documentation : `npm run docs:generate` ; aucun changement manuel du YAML généré.
- Migration nouvelle : aucune ; réutilisation de la projection 228 et des fonctions PostgreSQL natives, sans extension supplémentaire.
- Rollback : redéployer la version API précédente ; aucune donnée ni structure modifiée.
- Limite : parcours de la projection avec normalisation JSON à la lecture ; pas de benchmark à un volume de production ni promesse d'indexation FTS.

## Recette Web après déploiement API

Depuis la landing DESIGN FR puis EN, ouvrir Marketplace sans MARKETPLACE_PREVIEW.
Retrouver **Le Jardin du Fleuve** depuis les données réelles, vérifier son résultat dans la liste et son marqueur si ses coordonnées sont publiées, puis ouvrir sa fiche via chacun.
Vérifier filtres pays/ville/activité, tri A–Z, géolocalisation au clic, tri distance, conservation des non-localisés et identité liste/carte de la page.
Le merge, le déploiement et cette recette réelle restent à effectuer après revue ; les tests ci-dessus portent sur PostgreSQL local seedé, pas sur DESIGN ou production.
