# Premier démarrage sur le K3s existant

Le chart `konektag-api` conserve les Dockerfiles, scripts et traitements existants. Par défaut : API activée, workers outbox/comptabilité désactivés, chaque MCP désactivé et activable séparément, tous les CronJobs et ingress désactivés. Aucun Secret, PVC, logiciel tiers ou schéma de base n'est créé. Aucun hook de migration n'est exécuté. Ne pas utiliser les noms synthétiques de `tests/fixtures/helm-values.yaml` dans le cluster.

## Paramètres à relever sur la plateforme

Fournir un fichier de valeurs privé, relu pour le namespace existant. Les champs vides du chart doivent recevoir les références réelles ; ce document ne suppose aucun nom Kubernetes.

| Valeur Helm | Configuration existante à fournir |
| --- | --- |
| `image.repository`, `image.tag` | Préfixe des quatre images conservées et SHA Git complet ; API et workers utilisent la même image `-api` |
| `imagePullSecrets` | Références existantes uniquement si le registre les exige |
| `api.existingSecret` | Secret existant du backend, dans le namespace cible ; également utilisé par les workers sélectionnés |
| `api.env` | Configuration publique ; ne pas y mettre de secrets |
| `api.volumes`, `api.volumeMounts` | Volumes existants réellement requis par les opérations retenues (CMS/GeoIP, sanctions, etc.) ; sinon laisser vides |
| `ingress.host`, `ingress.tlsSecret` | Domaine dédié de l'API et certificat existants, si cet ingress est explicitement activé |
| `siteApiIngress.host`, `siteApiIngress.tlsSecret` | `www.konektag.eu` et référence réelle du certificat existant, uniquement lors de la bascule explicitement décidée |
| `mcp.<nom>.existingSecret`, `mcp.<nom>.oauthClaim` | Secret et PVC OAuth déjà présents, distincts pour chaque MCP activé (`erpnext`, `m365`, `unipile`) |

Dans le Secret backend existant, configurer `DATABASE_URL` vers la base PostgreSQL existante (schéma `konektag` déjà provisionné), `REDIS_URL` vers Valkey existant, `DATA_ENCRYPTION_KEY` compatible avec les données et `INTERNAL_API_TOKEN`. Reprendre les accès et options TLS réels ; ne pas utiliser les hôtes de secours du code comme inventaire du cluster. Aucun nouveau PostgreSQL ou Valkey n'est installé.

Configurer Keycloak existant avec `KEYCLOAK_BASE_URL`, `KEYCLOAK_REALM`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_ID`, `KEYCLOAK_ADMIN_CLIENT_SECRET`. Conserver la configuration de session/cookies et les clients/redirect URIs déjà autorisés. `API_PUBLIC_URL` est l'origine HTTPS publique retenue pour l'API, sans suffixe `/api` ; `PUBLIC_SITE_URL` reste l'origine du site existant. L'API n'héberge ni `/g/{id}`, ni les pages de checkout ou de connexion du site.

Raccorder les opérations aux progiciels existants avec leurs variables actuelles : ERPNext (`ERPNEXT_URL`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET`), stockage objet (`MINIO_*`), Postiz, Mautic et PSP selon les consommateurs listés dans `docs/environment-variables.json`. Ne pas installer ces services ni recopier un environnement frontend. Ce démarrage n'ajoute aucun routage ERPNext multi-sites.

Chaque MCP garde sa propre configuration : `MCP_PUBLIC_URL`, endpoints OAuth/JWKS, issuer/audience, client et secret du client existant ; `OAUTH_STORE_DIR` doit désigner le stockage OAuth persistant monté (par défaut `/app/data/oauth`). ERPNext utilise `FRAPPE_URL` et ses credentials existants ; M365 utilise le tenant, client, mailbox et certificat PFX existants via `extraVolumes`/`extraVolumeMounts` ; Unipile conserve son accès actuel. Voir également le README racine et l'inventaire des variables.

## Activation indépendante

Les valeurs par défaut suffisent pour un premier rendu API seule après fourniture de l'image et du Secret API. Un worker se sélectionne avec `workers.outbox=true` ou `workers.accounting=true` ; aucune activation ne déclenche l'autre. Leurs traitements n'ont pas été modifiés. Vérifier le transfert de responsabilité avec les processus déjà en production avant toute activation.

Chaque MCP se sélectionne avec `mcp.<nom>.enabled=true`. Une release MCP seule peut définir `api.enabled=false`, laisser les deux workers et tous les jobs désactivés, et activer uniquement le MCP choisi. Elle n'exige alors aucun Secret API ni référence OAuth pour les MCP désactivés. Le routage MCP et sa découverte restent ceux du chart existant ; `mcpIngress.enabled` est une décision séparée. Le script de vérification contrôle les workloads présents dans la release.

Aucune migration n'est lancée au démarrage. Vérifier que le schéma déjà utilisé par le backend extrait est présent ; ne pas appliquer de migration destructive. Les preuves de readiness opérationnelle des workers/contrôles peuvent rester manquantes tant que leurs propriétaires ne les ont pas activés ; `/api/internal/health` vérifie les dépendances API PostgreSQL/Valkey.

## Traefik : configuration préparée, activation manuelle

Deux ingress indépendants sont disponibles :

- `ingress.enabled` expose `/api`, `/v1`, `/docs`, `/openapi.json` sur le domaine API dédié renseigné.
- `siteApiIngress.enabled` expose uniquement le préfixe Kubernetes `/api` sur `siteApiIngress.host` (`www.konektag.eu`). Il ne capture ni `/apiary`, ni `/`, ni `/g/{id}`, ni `/v1` sur le site.

Les deux restent désactivés par défaut. L'ingress du frontend existant conserve `/` et ses autres chemins ; aucun fichier ni workload frontend n'est modifié. Traefik doit sélectionner la route `/api` plus spécifique ; avant activation, contrôler les règles et priorités explicites de l'ingress existant et l'absence d'un autre propriétaire de `/api`. Ne pas activer simultanément deux backends concurrents pour ce préfixe. Les Secrets TLS doivent déjà exister dans le namespace.

Aucun StripPrefix, ReplacePath, redirect, filtre de méthode, réécriture de cookies ou de headers n'est ajouté. `/api/...` arrive intact au backend, avec sa query string, sa méthode, ses headers, cookies et payload ; les réponses et `Set-Cookie` suivent le transport existant. Les cookies du navigateur restent soumis à leurs attributs Domain/Path/Secure/SameSite actuels : l'accès par un domaine dédié n'implique pas qu'un cookie limité au site y sera envoyé. Aucune modification de ces attributs n'est effectuée. Les alias historiques `/v1/payments` et `/v1/payments/{id}` utilisent les mêmes handlers et le même chemin canonique interne pour l'authentification, le KYC et l'idempotence ; ils ne redirigent pas le client.

## Commandes rejouables sans accès cluster

Depuis la racine, avec Node 24, Python 3.12 et Helm 3 :

```bash
npm ci
npm run docs:generate
npm run typecheck
npm test
npm run build
node src/infrastructure/scripts/smoke.mjs
python -m pip install -r src/mcp/requirements.lock.txt
python -m pytest src/mcp/mcp/tests src/mcp/mcp-unipile/tests tests/mcp -q
python -c 'from pathlib import Path; import yaml; from openapi_pydantic import OpenAPI; OpenAPI.model_validate(yaml.safe_load(Path("docs/openapi.yaml").read_text()))'
helm lint src/infrastructure/k8s/konektag-api -f tests/fixtures/helm-values.yaml
helm template validation src/infrastructure/k8s/konektag-api -f tests/fixtures/helm-values.yaml
node src/infrastructure/scripts/validate-helm.mjs
bash -n src/infrastructure/scripts/*.sh
```

`validate-helm.mjs` rend les valeurs par défaut, chaque worker séparément, chaque MCP seul et les deux ingress explicitement activés avec les références synthétiques des tests. Il ne contacte aucun cluster. Les commandes de déploiement conservées dans le README racine nécessitent les valeurs et le namespace réels ; elles ne font pas partie de cette validation et n'ont pas été exécutées.

## Résultats de cette correction — 3 novembre 2026

Validation locale depuis `a6ef94d2eef2bfb19289957ce97db120bed5892d`, avec Node 24, Python 3.12 et Helm 3.19.0 :

| Contrôle | Résultat |
| --- | --- |
| TypeScript et build | Réussis ; API, workers et jobs conservés |
| Tests Node | 136 fichiers, 1 289 tests réussis, dont 7 tests des alias |
| Tests Python MCP | 85 réussis ; 2 avertissements de dépréciation Authlib existants |
| Génération et validation OpenAPI 3.1 | 307 chemins / 392 opérations ; les 305 contrats existants sont inchangés |
| Smoke HTTP local | Swagger/OpenAPI, refus anonyme des routes canoniques et historiques, health dégradé avec dépendances volontairement absentes |
| Entrées workers locales | Démarrages isolés sur une base volontairement indisponible ; aucun événement traité |
| Helm | Lint et 14 rendus validés : défauts, chaque worker avec/sans API, chaque MCP seul avec/sans ingress, API sans références MCP, double ingress explicite, release vide |
| Routage préparé | Préfixe site `/api`, domaine API distinct avec `/v1`, aucune capture de `/` ou `/g`, aucune transformation ajoutée |
| Scripts et diff | `bash -n` et `git diff --check` réussis |

Ces vérifications utilisent des doubles ou des ressources locales. Elles ne constituent pas un test contre le Traefik ou les services réels du cluster. Aucun déploiement K3s, migration, publication d'image, CronJob ou bascule du frontend n'a été effectué. Les tests sont également exécutés sur PR par le workflow existant, enrichi de la régénération reproductible OpenAPI et des rendus Helm.
