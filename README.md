# Konektag API

Backend extrait de `startpointcorporate/konetag` au commit `c25c1ac5d42d0e173b9dec28c950617d109d0530` : **305 chemins REST extraits, 2 alias de compatibilité (392 opérations HTTP au total) et 42 outils MCP**. Le dépôt source est en lecture seule. Aucun framework Astro, SSR, page métier, composant navigateur ou CSS n'est nécessaire au backend.

## Installation et validation

Node.js 24, Python 3.12 et Docker sont les runtimes utilisés pour la validation. Utiliser le checkout existant ; aucun worktree supplémentaire n'est nécessaire.

```bash
npm ci
python3.12 -m venv .venv
.venv/bin/python -m pip install -r src/mcp/requirements.lock.txt
npm run typecheck
npm test
.venv/bin/python -m pytest src/mcp/mcp/tests src/mcp/mcp-unipile/tests tests/mcp -q
npm run build
```

Les tests HTTP des MCP utilisent uniquement des ports locaux, une configuration synthétique et un stockage OAuth temporaire. Les tests métier simulent les ressources externes. Ils n'effectuent aucune écriture sur la plateforme existante.

## Démarrage

Configurer les accès existants via les variables d'environnement ou un fichier `.env` local ignoré, à partir de `.env.example`. Ne jamais copier les `.env` du dépôt source. `DATABASE_URL` est nécessaire au chargement du serveur ; les routes et workers exigent ensuite leurs dépendances réelles. L'inventaire des noms de variables et de leurs consommateurs est dans [docs/environment-variables.json](docs/environment-variables.json).

```bash
node --env-file=.env dist/server.mjs
# Processus distincts, avec leur configuration et leurs accès dédiés :
node --env-file=.env dist/outbox-worker.mjs
node --env-file=.env dist/accounting-worker.mjs
```

L'API écoute sur `HOST`/`PORT` (défaut `0.0.0.0:3000`). `API_PUBLIC_URL` doit représenter l'origine HTTPS exposée par Traefik. `PUBLIC_SITE_URL` reste l'origine du frontend existant pour les URL de retour et de notification. Le backend n'héberge pas ces pages.

- `/docs` : Swagger UI, avec ressources servies localement.
- `/openapi.json` : JSON généré pendant le build depuis `docs/openapi.yaml`.
- `/livez` : présence du processus HTTP.
- `/api/internal/health` : disponibilité PostgreSQL et Valkey.
- `/api/internal/operational-readiness` : preuves durables des workers et contrôles, protégé par `INTERNAL_API_TOKEN`.

Le middleware conserve les identités Keycloak, les clés API utilisateur et marchand, les rôles, les restrictions KYC, les blocages financiers et l'idempotence. Il ne lance aucun worker, y compris via le bootstrap des routes.

### MCP Python

Les trois serveurs gardent leur langage, leurs outils et leurs confirmations humaines. Démarrer chaque processus avec son propre environnement et son stockage OAuth persistant :

```bash
(cd src/mcp/mcp && ../../../.venv/bin/python server.py)
(cd src/mcp/mcp-m365 && ../../../.venv/bin/python server.py)
(cd src/mcp/mcp-unipile && ../../../.venv/bin/python server.py)
```

`MCP_PUBLIC_URL` est obligatoire pour chaque serveur. Les ports sont configurables via `MCP_PORT` pour ERPNext/M365, et `UNIPILE_MCP_PORT` pour Unipile. Utiliser des ports distincts en local. `OAUTH_STORE_DIR` désigne un répertoire persistant distinct par serveur (défaut `/app/data/oauth`). Les URLs OAuth et JWKS, audience, client et secret doivent être ceux de l'application Keycloak correspondante. L'identifiant public d'un MCP ne doit pas être réutilisé pour les autres.

M365 exige aussi `M365_CLIENT_ID`, `M365_TENANT_ID`, `M365_MAILBOX` et le certificat fourni via `M365_PFX_PATH` et, si nécessaire, `M365_PFX_PASSWORD`. Unipile conserve ses comptes et sa clé API existants. Le MCP ERPNext utilise `FRAPPE_URL`, `FRAPPE_API_KEY`, `FRAPPE_API_SECRET`, et les configurations Postiz/Konektag pour les outils concernés.

## Mutualisation et provenance

Les routes REST importent une seule copie des services `src/application`, modèles `src/domain`, repositories et adaptateurs `src/infrastructure`. Le MCP CPM conserve `CPMClient → KonektagClient → /api/admin/boost-pricing*` : les règles de prix, autorisations et écritures restent dans les services REST. Les outils ERPNext et Postiz autonomes gardent leurs connecteurs Python existants ; aucune réécriture TypeScript n'a été ajoutée.

- [docs/source-manifest.json](docs/source-manifest.json) : correspondance source/destination et empreintes du source.
- [docs/routes.json](docs/routes.json) : routes et méthodes réellement exportées.
- [docs/mcp-tools.json](docs/mcp-tools.json) : noms, signatures et empreintes AST des 42 outils.
- [docs/migration.md](docs/migration.md) : adaptations et limites de validation.
- [docs/validation.md](docs/validation.md) : commandes exécutées et résultats observés.

Les catalogues conservés servent aux réponses REST (documents légaux, erreurs de paiement, recommandations de visibilité). Les anciens modèles de pages ont été remplacés par les seules déclarations de données utilisées par les services. L'image de secours de `/api/photo/{id}` est une ressource binaire de cet endpoint.

## Swagger UI avec Keycloak (OAuth2 / PKCE)

Swagger UI est servi localement sur `/docs`. Le bouton **Authorize** utilise le realm `konektag` de `https://login.konektag.eu`, le client public `frontend-konektag`, et le flux Authorization Code avec PKCE S256. Aucun secret administrateur n'est envoyé au navigateur. L'API accepte les JWT **utilisateur** signés par le realm configuré dans `Authorization: Bearer <token>`, en recherchant ensuite l'utilisateur dans `konektag.users` et en conservant les restrictions KYC, compte bloqué et idempotence. Les API keys et tokens marchands conservent leurs chemins existants ; un jeton machine-à-machine `directus-konektag` n'est pas un utilisateur Swagger.

**Précondition obligatoire pour activer la connexion depuis un navigateur :** exposer `/docs`, `/docs/oauth2-redirect.html` et `/openapi.json` sur une origine HTTPS d'API explicitement choisie. Dans Keycloak, ajouter **uniquement** cette URL exacte dans les Valid Redirect URIs du client `frontend-konektag` :

```text
https://<domaine-api-validé>/docs/oauth2-redirect.html
```

Définir les Web Origins correspondant à cette origine HTTPS validée et vérifier les règles CORS du serveur. Le chart laisse l'ingress désactivé par défaut ; ne pas activer de redirection wildcard. Aucun domaine n'est inventé ou ajouté automatiquement par cette PR. Les essais sur URL interne du cluster ne peuvent pas réaliser la redirection OAuth navigateur.

Après déploiement de l'image revue, ouvrir `https://<domaine-api-validé>/docs`, cliquer **Authorize**, puis tester `GET /api/auth/me` avec un utilisateur déjà inscrit dans la base Konektag. Le compte machine ne suffit pas. L'absence de compte applicatif pour un sujet Keycloak valide renvoie `USER_NOT_ONBOARDED` (401).

## OpenAPI

`docs/openapi.yaml` est la seule spécification publiée. `npm run docs:generate` permet de la régénérer depuis les handlers ; vérifier son diff avant commit. Le build produit seulement le JSON dérivé. Les schémas décrivent les objets littéraux et validations Zod locales détectables ; les champs calculés par les services/SQL restent explicitement non contraints. La spécification ne constitue pas une certification des réponses des ressources externes. Voir les extensions `x-source`, `x-error-codes` et `x-response-schema-scope`.

## Images et K3s

Tous les Dockerfiles, chart Helm et scripts sont sous `src/infrastructure`. Aucun PostgreSQL, Valkey, ERPNext, Keycloak, Postiz, Mautic ou système d'observabilité n'est réinstallé. Aucune migration de schéma n'est lancée automatiquement. Les Secrets et volumes OAuth doivent déjà exister.

```bash
docker build -f src/infrastructure/docker/api.Dockerfile -t "$IMAGE_REPOSITORY-api:$IMAGE_TAG" .
for service in mcp mcp-m365 mcp-unipile; do
  docker build --build-arg SERVICE="$service" -f src/infrastructure/docker/mcp.Dockerfile \
    -t "$IMAGE_REPOSITORY-$service:$IMAGE_TAG" .
done

# IMAGE_TAG = SHA Git complet ; VALUES_FILE = fichier relu pour le cluster cible.
NAMESPACE=... RELEASE=... IMAGE_REPOSITORY=... IMAGE_TAG=... VALUES_FILE=... \
  ./src/infrastructure/scripts/deploy.sh
NAMESPACE=... RELEASE=... ./src/infrastructure/scripts/verify-deployment.sh
NAMESPACE=... RELEASE=... REVISION=... ./src/infrastructure/scripts/rollback.sh
```

Le script `python src/infrastructure/scripts/docker-smoke.py` rejoue les contrôles Docker isolés sur les quatre tags locaux `konektag-{api,mcp,mcp-m365,mcp-unipile}:validation`.

Dans un environnement Codex avec interception TLS, ajouter `--secret id=proxy_ca,src=/etc/ssl/certs/ca-certificates.crt` à chaque build. Le certificat n'est pas copié dans les images. La vérification TLS reste active.

Le chart active par défaut uniquement l’API. Les deux workers et chaque MCP sont activables indépendamment et restent désactivés par défaut. Voir [le guide du premier démarrage K3s](src/infrastructure/k8s/README.md), avec les paramètres des services existants et les deux ingress Traefik optionnels. `mcpIngress` reprend le routage Traefik existant et la découverte OAuth sous préfixe ; ses hôtes et Secrets TLS doivent être explicitement configurés. Les MCP utilisent un replica et la stratégie Recreate pour conserver la cohérence du stockage OAuth. Les probes MCP vérifient la découverte OAuth ; la readiness des workers vérifie leurs preuves durables en base, pas seulement leur PID.

Les sept jobs existants sont compilés sous `dist/jobs` : rapprochement quotidien, import sanctions, re-screening, rétention, synchronisation Postiz, intégrité wallet et rapprochement PawaPay. Leur activation dans le chart est **désactivée par défaut** pour éviter de doubler les planifications existantes. L'activation de la rétention exige une validation opérationnelle explicite ; aucune purge n'a été exécutée. Réutiliser les volumes sanctions et les accès existants via les valeurs du chart.

Les exemples `tests/fixtures/helm-values.yaml` utilisent des noms synthétiques réservés aux validations hors cluster. Ne pas les déployer.

### GitHub Actions

Les PR exécutent les contrôles sans déploiement. `deploy.yml` ne publie les images et ne déploie que sur `workflow_dispatch` avec un environnement GitHub choisi explicitement. Configurer ses protections et approbations avant usage.

Les noms suivants constituent **des exigences à configurer**, et non des secrets supposés existants :

| Configuration de l'environnement GitHub | Usage |
| --- | --- |
| Variable `K3S_DEPLOY_ENABLED=true` | Autorisation explicite du workflow |
| Variable `IMAGE_REPOSITORY` | Préfixe GHCR, par exemple le chemin GHCR validé pour ce dépôt |
| Variables `K3S_NAMESPACE`, `K3S_RELEASE` | Namespace existant et release cible |
| Variable `K3S_HELM_VALUES` | YAML non secret : références aux Secrets/PVC et configuration publique |
| Secret `K3S_KUBECONFIG` | Kubeconfig brut avec RBAC limité au namespace cible |
| `GITHUB_TOKEN` fourni par GitHub | Publication GHCR, permission `packages: write` |

Le runner doit pouvoir joindre l'API K3s. Le cluster doit pouvoir tirer les images GHCR, avec un `imagePullSecrets` existant si elles sont privées. Les images sont référencées par SHA de commit ; aucun tag `latest` n'est utilisé. Le retour arrière utilise une révision Helm existante. Aucun déploiement de production n'a été exécuté depuis cet environnement.

### Couverture REST examinée

`npm run test:rest:coverage` régénère le contrat et exécute la suite Vitest avant de produire la [matrice OpenAPI ↔ tests](docs/rest-test-coverage.md) et le [rapport JSON](docs/rest-test-coverage.json). Le [rapport d'audit](docs/rest-test-audit.md) décrit les preuves métier, les limites et le défaut Resend connu. Les tests de transport/auth seuls restent partiels. La CI vérifie les preuves exécutées et refuse les régressions par opération ; aucun déploiement n'est effectué par ce contrôle.
