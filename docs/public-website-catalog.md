# Catalogue public PUBLIC WEBSITE (KON-108)

Deux routes publiques, sans authentification, lisent en direct le catalogue ERPNext d'un site Frappe :

| Route | Rôle |
|---|---|
| `GET /api/public/catalog/items?site=…\|country=…` | liste paginée (`limit` ≤ 50, `cursor` opaque), filtres `group`, `q`, `priced`, `currency` |
| `GET /api/public/catalog/items/{ref}?site=…\|country=…` | fiche publique par code article ERPNext ou slug |

Contrat : `docs/openapi.yaml` (`listPublicCatalogItems`, `getPublicCatalogItem`) et types TypeScript
`PublicCatalogListResponse` / `PublicCatalogItemResponse` de `src/application/public-website/catalog-service.ts`.

## Choix du site

Le navigateur envoie **soit** `site` (identifiant public, par exemple `rocher-des-ages`), **soit** `country`
(pays de résidence). Les deux passent par le routeur partagé de KON-107, `resolveFrappeSite`
([frappe-site-routing.md](frappe-site-routing.md)) :

- `country` → `payment_country_mappings` → `konektag-fr|cg|lb` (inchangé), `kind = KONEKTAG` ;
- `site` → registre fermé `KONEKTAG_FRAPPE_SITE_REGISTRY`, appel **anonyme** de scope `catalog:read` : le scope doit
  figurer dans `publicScopes` de l'entrée et, si le navigateur envoie un `Origin`, celui-ci doit être dans
  `allowedOrigins` (sinon `403 SITE_ACCESS_FORBIDDEN`). Un rendu serveur sans `Origin` n'est soumis qu'au scope.

Sélecteur absent, double ou mal formé : `400 SITE_SELECTOR_INVALID`. Il ne transmet jamais d'URL ni de clé Frappe. Un
site inconnu, désactivé, ou qui ne publie pas de catalogue répond le même `404 SITE_NOT_FOUND`. Les réponses portent
`Vary: Origin`. Le port `PublicSiteResolver` (`src/application/public-website/site-context.ts`) isole les routes du
routeur.

## Publication par site : `PUBLIC_CATALOG_SITES`

Un site ne publie son catalogue que s'il a une entrée, clé = `frappeSiteId` du registre (ou slug `konektag-<pays>`).
Exemple pour les deux sites initialisés le 2026-11-19 :

```json
{
  "rocher-des-ages": { "priceLists": ["Rocher des Âges — Tarifs commerciaux"] },
  "abm-demo": { "priceLists": ["ABM Demo — Tarifs de démonstration"], "abmResources": true }
}
```

| Clé | Effet |
|---|---|
| `priceLists` (obligatoire) | listes de prix de vente publiques, dans l'ordre d'affichage |
| `itemGroups` | liste blanche de groupes d'articles ; absente : tous |
| `publishedField` | champ Check d'Item qui doit valoir 1 (si le site en crée un) |
| `characteristicFields` | champs d'Item affichés comme caractéristiques `[{ "field", "label" }]` ; les champs internes (comptes, valorisation, achat, stock, fournisseur, client, taxes…) sont refusés au chargement |
| `virtualTourHosts` | hôtes de visites virtuelles en plus de Matterport, Kuula, Momento360, Roundme, 360Cities |
| `abmResources` | lie les articles aux ressources konektag-abm |
| `mediaOrigin` | origine publique `https://` des `/files/` lorsque l'API joint Frappe par une URL interne (`*.svc.cluster.local`) ; sans elle, les fichiers Frappe ne sont alors pas publiés |
| `timezone` | fuseau IANA qui décide si une période de prix est en cours (défaut `UTC`) |

La configuration ne contient aucun secret. Les identifiants restent dans `MARKETPLACE_FRAPPE_<SITE>_*`. Le compte de
service doit pouvoir **lire** `Item`, `Item Price`, `File` (et `ABM Resource`, `ABM Equipment Pool` si `abmResources`).
Cette PR ne modifie ni les Secrets, ni la configuration déployée, ni Frappe.

## Règles de projection

- **Article publié** : `disabled = 0`, `is_sales_item = 1`, pas un modèle de variantes, plus `itemGroups` et
  `publishedField` s'ils sont configurés. Les fiches de référence internes (par exemple `RDA-SAL-*`, non vendables)
  et le matériel de démonstration ne sont jamais publiés.
- **Liste blanche** : seuls code, nom, groupe, unité, marque, description (texte brut, HTML retiré), champs
  configurés et attributs de variante sortent. Comptes, valorisation, achats, propriétaire, stock : jamais.
- **Prix** : `Item Price` de vente des listes configurées, sans client ni lot, non expirés ; les tarifs futurs sont
  rendus avec `current: false`. Le prix d'appel (`price.from`) est, dans la première liste qui tarife l'article, le
  tarif en vigueur (dernier `valid_from`) dans l'unité de vente de l'article, sinon le plus bas. Montant ≤ 0 ou absent = `NOT_PRICED` avec `from: null` (ERPNext propose 0,00 sans
  prix). Les montants sont des tarifs de liste ; les taxes restent calculées par ERPNext sur le devis.
- **Médias** : `Item.image` (couverture) puis les `File` attachés à l'article, `is_private = 0`, par date de création.
  Seuls un chemin public `/files/…` du site ou un lien externe `https://` sont acceptés, contrôlés **après** analyse
  de l'URL (`%2e%2e`, tabulations, point final d'hôte) ; `/private/`, `/api/method/`, `http://` et identifiants dans
  l'URL sont rejetés. Type déduit de l'extension ou de l'hôte :
  `IMAGE`, `VIDEO` (fichier, YouTube, Vimeo, Dailymotion), `VIRTUAL_TOUR`. Les PDF et autres fichiers sont ignorés.
- **ABM** : `ABM Resource.selling_item` et `ABM Equipment Pool.item` actifs. DocType absent : `NOT_INSTALLED` ;
  désactivé dans la configuration : `NOT_CONFIGURED`. Le catalogue reste servi.
- **Cache** : instantané par site 60 s côté serveur (échec non mis en cache), `Cache-Control: public, max-age=60`,
  `ETag` et `304` sur `If-None-Match`. 1 000 articles au plus par site (au-delà : tronqué et journalisé). Les attributs d'une
  variante sont lus à la première consultation de sa fiche, puis mis en cache avec l'instantané.
- **Slug** : dérivé du code article ; en cas de collision, l'article le plus ancien garde le slug nu et les suivants
  reçoivent un suffixe stable, si bien qu'un nouvel article ne change jamais un slug déjà publié.

## Analyse des écarts (aucun DocType créé)

| Besoin | Natif retenu | Écart et suite possible |
|---|---|---|
| Slug public | dérivé du code article (stable) | ERPNext v15 n'a plus de route web sur Item (app Webshop non supposée installée). |
| Drapeau « publié » | `is_sales_item` + groupes | Un champ Check dédié peut être créé dans `konektag_360` puis nommé dans `publishedField`, sans code API. |
| Vidéo, visite virtuelle | `File` avec URL externe attaché à l'article | Pas d'ordre manuel ni de légende sur `File` : ordre par date de création, texte alternatif = nom de l'article côté Web. Une table enfant ne se justifie que si l'ordre/légende devient un besoin. |
| Fiche marketing détaillée | `description` d'Item | Pas de champ distinct marketing/interne en natif : publier une description interne serait une erreur de saisie ; un champ dédié peut être exposé via `characteristicFields`. |
| Ressources ABM | DocTypes de `konektag-abm` (PR #1, non fusionnée) | Non installé sur Rocher des Âges : `NOT_INSTALLED`. |

## Recette et limites

`tests/unit/public-website-catalog.test.ts` simule un Frappe par hôte derrière le **vrai** transport HTTP de l'API :
fixtures Rocher des Âges (14 prestations, aucun tarif XAF chargé → toutes `NOT_PRICED`), ABM Demo (14 tarifs de
démonstration, médias, ressources ABM) et Konektag CG via `country=CM`. Aucune lecture n'a été faite sur les sites
réels : ce run ne dispose d'aucun identifiant Frappe. La recette réelle nécessite l'entrée `PUBLIC_CATALOG_SITES`,
l'entrée du registre KON-107 avec `catalog:read` dans `publicScopes`, les Secrets du site et les droits de lecture
ci-dessus.
