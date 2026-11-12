# Déploiement automatique API après validation CI

## Fonctionnement

- Une PR vers `main` déclenche les tests `REST test coverage`, **sans déploiement**.
- Après fusion, le push sur `main` déclenche la CI ; son événement `workflow_run: completed` déclenche le job de déploiement uniquement si `conclusion=success`, `event=push`, `head_branch=main` et dépôt source identique.
- Le déploiement récupère **le SHA exactement testé** et vérifie qu'il est toujours le HEAD de `main`. Les exécutions CI anciennes ne peuvent pas rétrograder l'API.
- L'environnement GitHub fournit les secrets SSH du déploiement; `K3S_DEPLOY_ENABLED=true` reste obligatoire. Le groupe de concurrence `konektag-api-production-pvc` évite deux activations simultanées.
- `deploy-api.sh` provisionne ou réutilise le pod technique `konektag-api-setup`, y construit la release, active la nouvelle version et contrôle la santé. Les manifests applicatifs, MCP, autres services et Helm ne sont pas modifiés. Les processus API/outbox suivent leur pointeur de release existant.
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

## Cycle du pod de construction

La définition est versionnée dans `deploy/k3s/api-setup.json` (manifest Kubernetes JSON). Elle reprend le PVC existant `konektag-api-code` monté sur `/app`, le nœud `konektag-clients` et le digest Node du runtime observé. Aucun Secret applicatif ni jeton de ServiceAccount n’est monté. `sleep 7200` reste un plafond de durée du conteneur, pas le mécanisme normal de nettoyage.

`deploy-api.sh` utilise `scripts/api-build-pod.sh ensure` seulement lorsqu’une nouvelle release doit être construite :

1. Comparer le PVC et le sélecteur de nœud avec le Deployment API existant ; refuser une cible différente.
2. Si le pod est absent, le créer depuis le manifeste. Si le pod conforme existe déjà, le conserver et attendre Ready ; un pod terminé est remplacé, un pod en suppression est attendu.
3. Conserver le build Linux x64, l’archive Git, la release immuable, l’activation et les vérifications de santé existants.
4. Sur sortie réussie, erreur ou signal INT/TERM, supprimer uniquement le pod technique. En cas d’échec après activation, le retour arrière existant précède ce nettoyage. Un échec de nettoyage n’est pas masqué et ne remplace pas le code d’erreur initial.
5. Le workflow réessaie le nettoyage dans une étape `always()` lorsque SSH a été configuré. Une nouvelle exécution nettoie aussi un pod résiduel quand la release est déjà active.

Le script de cycle est idempotent : `bash scripts/api-build-pod.sh cleanup` réussit aussi quand le pod est absent. Un pod au même nom mais dont le volume, l’image ou la commande ne correspondent pas est refusé avant réutilisation/suppression. Le PVC n’est jamais créé, modifié ou supprimé par ces scripts.

Le chemin `sudo -n k3s kubectl -n konektag-api ...` reste dans les droits existants de `ci-deploy`. Aucun droit n’est ajouté à Paperclip. Les lancements opérateur ne doivent pas concurrencer le workflow : le groupe de concurrence GitHub existant protège les exécutions CI.

Un arrêt forcé du runner ou une infrastructure SSH/Kubernetes inaccessible peuvent empêcher le nettoyage immédiat ; l’erreur est visible et le cycle suivant peut reprendre un pod résiduel conforme. Aucun mécanisme ne garantit une suppression distante pendant une coupure totale.

Validation CI/CD : `bash -n deploy-api.sh scripts/api-build-pod.sh` puis `node --test tests/deployment/api-build-pod.mjs`. La suite couvre création, réutilisation, remplacement, erreurs, signaux, rollback et nettoyage sans suppression du PVC.
