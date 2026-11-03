# Preuves de validation — 3 novembre 2026

| Contrôle exécuté | Résultat |
| --- | --- |
| `npm run typecheck` | Réussi, aucune erreur TypeScript |
| `npm test` | 135 fichiers, **1 282 tests réussis**, aucun échec ni test ignoré |
| `.venv/bin/python -m pytest src/mcp/mcp/tests src/mcp/mcp-unipile/tests tests/mcp -q` | **85 tests réussis**, deux avertissements de dépréciation Authlib |
| `npm run build` | API, deux workers, sonde worker et sept jobs compilés sans framework frontend |
| `node src/infrastructure/scripts/smoke.mjs` | Swagger, ressources statiques, OpenAPI, validation REST réelle, refus d'identité absente, health dégradé lorsque les dépendances sont indisponibles |
| Entrées indépendantes des workers | Démarrent avec configuration synthétique ; aucune base réelle ni événement traité |
| Couverture REST | 305 chemins / 390 opérations ; test de correspondance entre registre et OpenAPI |
| Couverture MCP | 42 noms, signatures et corps AST identiques aux outils source |
| Transports MCP locaux | 3 démarrages, découverte OAuth (dont préfixes M365/Unipile), refus anonyme HTTP 401 |
| Validation OpenAPI | Modèle OpenAPI 3.1 validé avec `openapi-pydantic` |
| `helm lint` | Réussi avec Helm 3.19.0 |
| `helm template` | 6 Deployments rendus ; API/MCP Ingress et 2 CronJobs explicitement activés pour le test ; aucune création de Secret ou PVC |
| `bash -n src/infrastructure/scripts/*.sh` | Réussi |
| Docker | Quatre images construites ; identifiants locaux dans `docs/images.json` |
| Runtime Docker isolé | Quatre images démarrées sans réseau externe ; API/OpenAPI/auth et découverte OAuth/refus anonyme des MCP vérifiés |
| Dépôt source | `git status --short` vide ; HEAD inchangé `c25c1ac5d42d0e173b9dec28c950617d109d0530` |

Les tests utilisent les versions Node directes du lockfile source et les dépendances Python verrouillées. Les images locales portent le tag `validation` uniquement pour cette vérification ; le workflow de publication utilise le SHA complet du commit.

Les commandes Docker ont utilisé le bundle CA du runtime comme secret BuildKit, sans désactiver la vérification TLS. Les conteneurs de vérification ont été supprimés après les tests.

**Non exécuté :** publication d'images au registre, transactions contre les progiciels réels, consommation d'événements réels, purge, migrations, déploiement/rollout/rollback K3s et lancement manuel du workflow de déploiement. Aucun de ces résultats n'est présenté comme réussi.

Les schémas OpenAPI dynamiques, le routage ERPNext multi-sites et les exigences d'intégration restantes sont détaillés dans `docs/migration.md`.
