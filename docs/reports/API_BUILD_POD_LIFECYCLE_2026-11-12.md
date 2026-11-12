# Infrastructure CI/CD — cycle du pod de construction API

Périmètre : provisionnement/nettoyage du builder dans le déploiement API existant. Aucun lien de clôture avec KON-72 ; aucun changement dans `src/`, les applications, les permissions ou les migrations.

## Problème et résultat

Le pipeline attendait `konektag-api-setup` sans le créer. Le pod étant temporaire et supprimé après les opérations, une exécution suivante échouait avec NotFound malgré un accès SSH/K3s fonctionnel.

Le manifeste `deploy/k3s/api-setup.json` devient la définition versionnée : même PVC `konektag-api-code`, montage `/app`, même nœud `konektag-clients`, même image Node au digest observé, sans Secret applicatif ni jeton de ServiceAccount.

## Mise en œuvre

- `scripts/api-build-pod.sh ensure` valide le PVC/nœud de l’API, crée le pod absent, réutilise un pod conforme et attend Ready. Un pod terminé est remplacé ; un pod en suppression est attendu.
- `scripts/api-build-pod-state.mjs` vérifie la définition avant réutilisation et suppression : aucun nettoyage d’un autre pod portant accidentellement le même nom mais une autre configuration.
- `deploy-api.sh` conserve le build Linux x64, le transfert Git, l’activation et les contrôles de santé. Son gestionnaire EXIT exécute le rollback existant en cas de besoin, puis nettoie le pod ; INT/TERM aboutissent aussi à ce nettoyage. Le code d’erreur initial est conservé.
- `.github/workflows/deploy.yml` vérifie le PVC plutôt que l’existence préalable du pod. Une étape `always()` réessaie le nettoyage après configuration SSH, même si le déploiement échoue.
- `.github/workflows/rest-tests.yml` exécute les tests CI/CD dédiés avant les contrôles applicatifs existants.
- La commande de nettoyage ne supprime que le pod, jamais le PVC. Le groupe de concurrence existant est conservé ; aucun élargissement de droits Paperclip ou ci-deploy.

Une release déjà active ne provoque pas de build/provisionnement inutile ; un éventuel pod technique résiduel conforme est néanmoins nettoyé.

## Vérification

Commande : `node --test tests/deployment/api-build-pod.mjs`.

15 scénarios réussis, avec SSH/Kubernetes simulés et vrais scripts shell :

- pod absent, création depuis le manifeste et nettoyage ;
- réutilisation sans remplacement d’un pod opérationnel ;
- remplacement des pods Failed/Succeeded et attente d’une suppression en cours ;
- refus d’un pod au mauvais PVC et d’un Deployment cible incohérent ;
- nettoyage répété sans pod ;
- build/activation réussis puis nettoyage ;
- erreur de build, readiness et retour arrière après échec santé ;
- interruption TERM avec sortie 143 et nettoyage ;
- release déjà active, sans build, puis suppression du pod résiduel ;
- première suppression échouée, erreur initiale conservée, puis nettoyage de secours réussi.

Syntaxe Bash et YAML des workflows validée.

Sur K3s réel : manifeste accepté en dry-run serveur sous le compte `ci-deploy`, avec ses droits existants. Le cycle ensure → ensure (UID identique) → cleanup → création puis erreur simulée et cleanup → cleanup sans pod a été exécuté sans lancer de build ni activer une release. Le PVC, le volume lié, l’UID du Deployment et du pod API, ainsi que le SHA actif restent identiques avant/après ; la santé API/PostgreSQL/Redis reste bonne.

Preuves opérateur : `/home/michel/docs/reports/api-build-pod-lifecycle-2026-11-12/cluster-lifecycle.json` et `tests-initial.log`. Ce fichier local n’est pas requis pour rejouer la suite simulée.

## Limites et livraison

Le workflow modifié doit être revu/fusionné avant de remplacer le comportement CD de main. Aucun déploiement applicatif de cette branche ni paiement réel/callback financier partagé effectué pendant la vérification.

Un arrêt forcé du runner ou une coupure complète SSH/Kubernetes peuvent empêcher la suppression immédiate : les erreurs restent visibles et l’exécution suivante reprend un pod résiduel conforme. Aucun PVC n’est supprimé pour traiter ce cas.

Le nettoyage des répertoires de release incomplets et les procédures de migration restent ceux du projet, hors de cette modification ciblée.
