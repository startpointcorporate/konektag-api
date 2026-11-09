# Déploiement automatique API après validation CI

## Fonctionnement

- Une PR vers `main` déclenche les tests `REST test coverage`, **sans déploiement**.
- Après fusion, le push sur `main` déclenche la CI ; son événement `workflow_run: completed` déclenche le job de déploiement uniquement si `conclusion=success`, `event=push`, `head_branch=main` et dépôt source identique.
- Le déploiement récupère **le SHA exactement testé** et vérifie qu'il est toujours le HEAD de `main`. Les exécutions CI anciennes ne peuvent pas rétrograder l'API.
- L'environnement GitHub fournit les secrets SSH du déploiement; `K3S_DEPLOY_ENABLED=true` reste obligatoire. Le groupe de concurrence `konektag-api-production-pvc` évite deux activations simultanées.
- `deploy-api.sh` construit dans `konektag-api-setup`, active la nouvelle version et contrôle la santé. Les workers, MCP, autres services et Helm ne sont pas modifiés.
- Le lancement manuel `workflow_dispatch` est conservé pour un redéploiement contrôlé.

## Configuration unique requise sur GitHub

Dans **Settings → Secrets and variables → Actions → Variables**, créer la **variable de dépôt** :

`K3S_DEPLOY_ENVIRONMENT = <nom exact de l'environnement GitHub existant utilisé pour les déploiements réussis>`.

Ce n'est pas une nouvelle configuration de secrets : la valeur doit correspondre exactement à l'environnement **existant**, dans lequel sont définis `K3S_DEPLOY_ENABLED=true`, `SSH_CORE_HOST`, `SSH_CORE_PORT`, `SSH_CORE_PRIVATE_KEY` et `SSH_CORE_KNOWN_HOSTS`.

Conserver les protections applicables (règles de branche `main`, validations d'environnement de production si présentes). Une approbation d'environnement peut retarder le déploiement, mais ne demande pas de lancer le workflow.

## Migrations

Les migrations SQL restent **séparées et contrôlées**. Le workflow ne les exécute pas et ne crée aucune base ni aucun secret.

Avant la première activation du code CPM, appliquer et vérifier la migration additive `226_social_cpm_observations.sql` après sauvegarde PostgreSQL. La CI de code ne remplace pas cette vérification en base réelle. Sans migration, les endpoints CPM peuvent renvoyer 503.

## Validation

1. Ouvrir la PR de cette modification et vérifier la CI.
2. Définir `K3S_DEPLOY_ENVIRONMENT` dans les variables du dépôt, en réutilisant l'environnement existant.
3. Appliquer la migration 226 si nécessaire, avant la fusion qui déclenchera le premier déploiement automatique.
4. Fusionner la PR dans `main` ; vérifier le workflow CI (push), puis le workflow CD (workflow_run) et son SHA.
5. Vérifier `/livez`, `/api/internal/health` et `/api/public/boost-cpm`. Un catalogue vide reste possible avant le premier import JSON.

En cas d'échec CI, **aucun déploiement ne démarre**. En cas de SHA remplacé par un nouveau commit sur `main`, l'ancien déploiement est refusé.
