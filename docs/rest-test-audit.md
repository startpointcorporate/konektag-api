# Audit REST — issue #7

Référence : [issue #7](https://github.com/startpointcorporate/konektag-api/issues/7). Base examinée : `f13d4e4ccc232183befff59e547da651ac10142b` (main, Swagger/Keycloak PKCE conservé).

## Audit initial

La génération depuis les exports HTTP retrouve **307 chemins / 392 opérations** ; les alias historiques `/v1/payments` sont des opérations distinctes. Avant les ajouts, **1 290 tests Vitest passent**. Les tests unitaires, de migration et MCP existants sont conservés.

La revue des assertions et des imports de handlers identifie initialement **43 opérations avec un scénario métier examiné, 22 partielles, 327 sans preuve REST examinée**. Les tests de services restent utiles, mais ne prouvent pas automatiquement les réponses, l'authentification ou les effets au niveau du handler REST. Les tests de migration OpenAPI vérifient l'inventaire ; leur passage ne certifie pas 392 comportements métier.

Exemples : `cash-agent` ne vérifiait que le statut 410 et reste partiel. Le test initial `legal-documents` vérifiait la délégation pays/langue et une erreur, mais pas le contenu en succès. Les tests Mobile Money de reçus vérifient des services ; les deux tests REST de la queue ne vérifient que 403. À l'inverse, les tests Stripe vérifient les arguments de règlement, le journal fournisseur, les doublons et l'absence d'effets indus ; les lectures financières vérifient leurs projections et leur périmètre utilisateur.

L'[instantané initial](rest-test-audit-before.json) conserve les classifications et preuves examinées. Les imports non revus sont conservés comme `candidates` dans le rapport courant, sans promotion automatique.

## Ajouts et résultat

- Les 392 opérations ont chacune deux tests générés à la collecte Vitest et regroupés par domaine : routage réel, paramètres, query, octets du corps, cookies et alias ; puis refus de credentials personnels invalides par le vrai middleware, sans accès DB. **Ce sont des preuves partielles**, pas des validations métier.
- Suites fonctionnelles par domaine : onboarding/OTP/documents légaux/auth/me, préférences, avis/parrainage, favoris, notifications, commandes/réservations, promotions, KYC et activation.
- Inscription avec le vrai service applicatif et des repositories/UnitOfWork isolés : création Keycloak simulée, chiffrement simulé, preuves légales, audit/outbox, conflit d'idempotence et compensation lorsque l'insertion utilisateur échoue.
- Compatibilité frontend : vrai routeur + middleware + handler auth/me, renouvellement d'une session expirée et deux cookies HttpOnly/Secure/SameSite=Lax avec leurs noms historiques. Le parcours des handlers onboarding est testé en séquence. Ce n'est pas un E2E Keycloak réel ni un test du frontend.

La [matrice complète](rest-test-coverage.md) et le [rapport JSON](rest-test-coverage.json) donnent les résultats exacts de la dernière exécution, opération par opération. `covered` signifie qu'un **scénario fonctionnel examiné** existe avec assertions autres que le statut ; cela ne signifie pas une couverture exhaustive de toutes les branches ou tous les statuts annoncés par OpenAPI. `partial` signale une preuve de contrat, de garde ou un scénario incomplet. `blocked` signale un défaut connu ou un obstacle documenté.

**L'issue n'est pas entièrement résolue : 315 opérations restent sans scénario métier REST examiné, dont le défaut send-otp.** Ces opérations sont identifiées individuellement par `businessStatus: uncovered`. Les 314 opérations partielles ne sont pas présentées comme réussites fonctionnelles. La génération des tests de transport/auth ne remplace pas l'écriture de fixtures et d'assertions métier pour ces domaines, notamment l'administration, les règlements, les mutations marchandes et les intégrations.

## Vérifications exécutées

| Vérification locale | Résultat |
| --- | --- |
| Avant changements, sur main f13d4e4 | 1 290 tests Vitest passent |
| Après changements | 2 215 / 2 215 tests, 145 fichiers passent ; 925 tests ajoutés |
| Génération automatique | 784 tests de transport/auth, explicitement partiels |
| Tests fonctionnels ajoutés | 129 cas ; 12 tests supplémentaires contrôlent le calcul de couverture |
| Couverture métier examinée | 43 → 77 opérations ; 314 partielles et 1 bloquée restent signalées |
| Cible complète avec `--check --baseline-ref origin/main` | Passe : rapport à jour et aucune régression |
| `npm run typecheck`, `npm run build`, `git diff --check` | Passent |
| Smoke existant, configuration locale synthétique | Passe : Swagger/PKCE, contrats et dépendances volontairement indisponibles |

Le smoke existant démarre puis arrête localement les points d'entrée workers, sans DB accessible et sans événement traité ; il ne déploie aucun service. Les résultats GitHub Actions sont à consulter dans la PR ; une exécution locale n'est pas présentée comme une preuve de CI distante.

## Défaut Resend reproduit — aucune correction métier appliquée

`sendTemplate()` retourne un booléen. Le handler `POST /api/onboarding/send-otp` ignore `false` et renvoie actuellement 200 avec « Email de confirmation envoyé ». Un test de caractérisation exécutable reproduit exactement ce comportement ; l'opération reste **blocked**, même si ce test passe. Une exception du fournisseur et une indisponibilité du stockage OTP sont testées séparément.

Proposition à examiner : vérifier explicitement le booléen et, en cas de `false`, retourner l'enveloppe d'erreur existante `{ error: 'SERVER_ERROR' }` avec HTTP 500 ; conserver l'erreur en cas d'exception, n'annoncer aucun envoi réussi. Décider aussi du traitement du code OTP stocké quand la livraison échoue. Avant application, remplacer la caractérisation par la régression attendue et tester la réaction de l'écran historique. La présente PR ne modifie ni ce comportement ni les règles métier pour faire passer les tests.

## Rejouer et maintenir les preuves

```sh
npm ci
npm run test:rest:coverage
npm run test:rest:coverage -- --check --baseline-ref origin/main
npm run typecheck
```

La cible régénère OpenAPI depuis le code, exécute **toute la suite Vitest existante et nouvelle**, puis recalcule la matrice. Le résultat brut est `work/rest-results.json` (artefact CI, non versionné). Le workflow REST ne contient aucun déploiement. Le workflow de déploiement existant reste inchangé et ses jobs K3s restent réservés à un dispatch explicite.

`tests/rest/coverage-contract-review.json` verrouille également les assertions du générateur par SHA-256. `tests/rest/coverage-reviews.json` lie explicitement opérations, tests exécutés, niveau, facettes, assertions examinées et SHA-256 du fichier testé. Une correspondance de nom/import ne suffit jamais. Le changement d'un fichier revu exige une nouvelle revue de ses assertions et la mise à jour explicite de cette preuve. Un test manquant, ignoré, en échec, une revue périmée ou un rapport périmé fait échouer le contrôle.

La CI compare chaque opération, ses facettes, son statut et les références de tests à la matrice du commit de base de la PR (ou du commit précédent sur main). Lors de la première introduction de l'outil, elle utilise la baseline versionnée. Aucun recul ne peut être masqué en augmentant la couverture d'un autre domaine. Une suppression/renommage de test existant exige une décision explicite sur la baseline et la politique du check ; ne pas effacer les preuves pour verdir le pipeline.

## Limites d'intégration et sécurité d'exécution

Les tests ajoutés utilisent des mocks/fakes Vitest de PostgreSQL, Valkey, Keycloak, Resend et des services externes ; les appels `fetch` non prévus sont bloqués dans ces suites. Aucun secret de production, aucun envoi d'email, paiement ou DB distant n'est utilisé. Les DELETE/écritures des favoris visent uniquement le mock de pool. Le fake UnitOfWork vérifie les appels métier, mais ne certifie pas la transaction PostgreSQL, ses contraintes ou le rollback réel.

Aucun test destructif de production, aucune migration exécutée, aucun déploiement K3s/MCP/workers/frontend. Les connexions réelles des fournisseurs et les parcours E2E doivent encore être validés avec services dédiés/DB jetable et nettoyage. Leur absence n'est pas transformée en faux succès ou en faux `blocked` : les opérations sans scénario restent explicitement partielles/non couvertes métier.
