# KON-75 — Reprise technique, sécurité et non-régression

Date : 2026-11-12, Europe/Paris. Exécution directe par Codex, sans délégation.
PR existante : https://github.com/startpointcorporate/konektag-api/pull/57
Base reprise : `194b62845b397983acd51e240662c56e40bc6b30` ; branche KON-75 existante.
Worktree : `/home/michel/projects/konektag-api-kon75-validation`.
Le SHA de livraison et le résultat CI associé sont publiés dans les commentaires PR/Paperclip après push.

## Résultat et portée

Contrats réels sandbox vérifiés depuis K3s ; corrections de sécurité, règlement et concurrence couvertes par des tests.
Aucun dépôt/payout/refund/checkout créé chez pawaPay. Aucun PaymentIntent Stripe déclenché.
Aucune écriture dans PostgreSQL/ERPNext partagés, aucun secret injecté dans leurs processus.
Aucune fusion, aucun déploiement, aucun redémarrage du Deployment partagé.
KON-75 n'est pas marquée terminée : revue finale humaine requise et limites explicites ci-dessous.

## Recette pawaPay réelle

Script contrôlé et exécuté : `scripts/recette/pawapay-v2-contract.ts`, via bundle esbuild du worktree.
Bundle SHA-256 : `d1570a6f1f27b04f4722b44cd362bd59a77aa48fcaff07e6ee29e328d168ee1e`.
Dernier pod : `kon75-contract-1794478801`, namespace `konektag-api`, nœud `konektag-clients`.
IP sortante observée : `31.70.104.198`, conforme à l'IP attendue.
Même namespace et nœud que l'API ; aucune NetworkPolicy dans ce namespace au contrôle.
Pod borné, non privilégié, UID 1000, rootfs RO, capabilities retirées, aucun jeton de service account.
Clé source présente sur `ubuntu-perso` : `/tmp/secretpawapay.txt`, permissions 0600.
Jeton transmis par stdin, absent des arguments/manifeste/sorties publiées ; fichier source conservé.
Les réponses publiées ne contiennent aucun numéro complet.
Nettoyage par finally : delete exit=0, absence du pod vérifiée=True.

| Appel réel | Résultat |
| --- | --- |
| GET /v2/active-conf?country=COG&operationType=DEPOSIT | 200 |
| GET /v2/public-key/http | 200, PEM P-256 valide |
| POST /v2/predict-provider, numéro de test officiel Airtel COG | 200, COG/AIRTEL_COG |

`signatureConfiguration.signedRequestsOnly=false` ; `signedCallbacks=true`.
Aucune nouvelle paire de clés marchandes générée ou enregistrée ; aucune protection désactivée.
La clé publique porte `HTTP_EC_P256_KEY:1`, format PEM/SPKI, courbe `prime256v1`.
Le téléphone normalisé contient 12 chiffres sans préfixe + ; parseur actuel compatible, aucun assouplissement ajouté.

| Opérateur | Statut | Auth | Min XAF | Max XAF | Décimales | PIN |
| --- | --- | --- | --- | --- | --- | --- |
| AIRTEL_COG | OPERATIONAL | PROVIDER_AUTH | 10 | 1500000 | NONE | AUTOMATIC, non réactivable |
| MTN_MOMO_COG | OPERATIONAL | PROVIDER_AUTH | 1 | 1000000 | NONE | AUTOMATIC, réactivable |

Les limites sont des chaînes `minAmount`/`maxAmount` dans `currencies[].operationTypes.DEPOSIT`.
Le support alternatif `minTransactionLimit`/`maxTransactionLimit` reste testé localement.
Les deux callbackUrl DEPOSIT renvoyées par active-conf correspondent à l'endpoint principal Konektag.
Preuve assainie versionnée : `docs/reports/KON75_PREUVES_CONTRAT_SANDBOX_2026-11-12.txt`.
Source officielle numéros : https://docs.pawapay.io/v2/docs/test_numbers.md
Signatures : https://docs.pawapay.io/v2/docs/signatures.md
Les probes MTN, préfixe + et numéro invalide de la première recette restent des preuves antérieures, pas de nouveaux appels de cette reprise.

## Défauts reproduits puis corrigés

1. Signature : cinq tests échouaient sur Signature-Date invalide/incohérente, composants non signés, validité excessive et cache partagé entre configurations.
   Correction : composants obligatoires et uniques, cohérence date/created, validité et ancienneté bornées à 300 s (+ skew), cache par clé logique et hôte.
   ECDSA P-256, correspondance keyId et digest SHA-256/SHA-512 restent obligatoires.
2. Configuration : cinq tests reproduisaient l'acceptation d'une URL incompatible avec la clé SANDBOX/LIVE, HTTP, chemin arbitraire ou userinfo.
   Correction : URLs officielles HTTPS sélectionnées par variables d'environnement et cohérentes avec le suffixe ; redirections authentifiées refusées.
3. Montants au règlement : deux tests reproduisaient une seconde multiplication par 100 des montants MINOR EUR/USD.
   Correction : valorisation et acquisition utilisent directement le montant MINOR déjà canonique ; le parcours historique MAJOR reste converti une fois.
4. Valeur économique XAF du lot : un test reproduisait une division injustifiée par 100.
   Correction : précision de la devise utilisée dans le service et le contrôle SQL ; migration additive 234, appliquée uniquement à PostgreSQL jetable.
   Aucune ligne financière historique réécrite et aucune migration appliquée au cluster.
5. Concurrence : quatre callbacks locaux concurrents reproduisaient un deadlock PostgreSQL entre événement et tentative lors de l'acquisition.
   Correction : ordre de verrouillage événement → commande/tentative cohérent au règlement.
   Preuve finale : une acquisition, un événement et un crédit K après quatre callbacks concurrents puis répétition.

## Isolation financière configurée

`environment=live` désigne le parcours métier réel, pas l'environnement PSP : il autorise comptabilité/acquisition/outbox.
La sélection PSP est signée côté serveur par le Payment Context, puis gelée sur commande et tentative.
Sans contrôle dédié, une configuration PSP sandbox pouvait donc alimenter le parcours métier live.

À la demande explicite de Michel, `PAWAPAY_ALLOW_SANDBOX` est désactivé par défaut.
Même true, il exige NODE_ENV=test, base `konektag_test` sur hôte de test, API/Web/ERPNext sur endpoints de test.
Les appels financiers sont refusés sur les paramètres de production partagés, y compris pour un ordre live.
Le verrou couvre adaptateur et initiations, tentatives, confirmation générique Mobile Money, consommation de callback,
réconciliation, émission de recharge et règlement final, y compris relances manuelles d'un ordre pawaPay.
Configuration, clés publiques, prédiction et consultations de statut restent utilisables sans le flag.
Le script de contrat réel a été rejoué avec l’autorisation financière sandbox désactivée : CONTRACT OK.

Profil d'attente onboarding : `config/pawapay-sandbox.env.example`, flag true uniquement sur instance isolée.
Profil futur : `config/pawapay-live.env.example`, clé LIVE et URL réelle via configuration, sans changer le code.
API_PUBLIC_URL, PUBLIC_SITE_URL, ERPNEXT_URL et URL de callback attendue du script sont paramétrables.
Documentation : `docs/pawapay-sandbox.md`.
Les contrôles de noms sont des garde-fous, pas une preuve de topologie : vérifier réellement bases, credentials,
workers/queues et portail callbacks avant toute activation financière. Aucun profil n'a été déployé.
La configuration callback actuelle du compte sandbox vise l'API partagée : elle ne constitue PAS un setup financier isolé.

## Montants et idempotence

12 EUR → 1200 centimes Stripe ; 12,21 USD → 1221 cents ; 8567 XAF → 8567 XAF pawaPay.
`amount_unit=MINOR` est conservé de la Payment Request ERPNext au PSP puis à l'acquisition.
Montant navigateur refusé ; TTC issu d'ERPNext ; aucun recalcul de TVA ; frais additionnels nuls sur ce parcours.
Tests : relance même référence, double démarrage, concurrence même téléphone et téléphones différents,
REJECTED/INVALID_AMOUNT, erreurs 4xx/réseau, timeout incertain, lookup de réconciliation, callbacks concurrents et répétés.
Les tests PostgreSQL exécutent les vrais verrous, événements, acquisitions, lots et écritures de crédit.
PSP, ERPNext et autorité de valorisation de ces tests sont des doubles locaux explicites, jamais des appels prestataire.

## Non-régression et exécution

- TypeScript : succès.
- Build : succès.
- Génération OpenAPI/routes : exécutée ; nouvelles erreurs 503 documentées, ancres YAML régénérées.
- Suite unitaires/REST : 183 fichiers, 2946 tests passants et 5 échecs attendus déclarés (2951 cas au total).
- Couverture REST : comparaison à la base de PR, aucun recul de statut ou test couvert supprimé.
- PostgreSQL jetable : 20 tests Points K réussis ; migrations complètes dont 234.
- Un job CI PostgreSQL jetable est ajouté pour exécuter ces deux fichiers à chaque PR.
- Les tests HTTP de locale, montants et rejets conservent leurs assertions ; hashes de revue couverture actualisés après relecture.
- Stripe, Link Pay, QR Pay et autres parcours restent dans la suite générale ; aucune nouvelle API/service métier créé.

Les journaux complets sont sous `/home/michel/docs/reports/kon75-validation-2026-11-12/`.
Une tentative exploratoire de lancer tous les PG sans prérequis a échoué : Link Pay E2E exige deux Frappe jetables,
Link Pay network exige une ancienne table exchange_rates absente et Marketplace possède un schéma autonome destructible.
Marketplace a passé ses 13 cas dans son propre setup ; il ne doit pas partager simultanément la base des tests Points K.
Ces suites ne sont pas annoncées validées intégralement et leurs échecs de prérequis ne sont pas masqués.

## Limites et revue

Aucun callback signé authentique pawaPay reçu pendant cette reprise : les tests cryptographiques utilisent le générateur local déjà présent dans les tests.
Aucun dépôt sandbox initié : les vrais scénarios financiers et la réception authentique restent à effectuer sur un runtime isolé autorisé.
Le code corrigé et sa migration ne sont pas exécutés dans l'API partagée ; sa sécurité déployée ne peut être certifiée par cette recette.
API partagée et outbox contrôlées : générations 15 et 10 inchangées, pods applicatifs conservés.
Paperclip refuse le changement de statut/propriétaire car une revue est en attente : MCP_REVIEW_REQUIRED.
Ce verrou est respecté ; résultats publiés sur KON-75 et la PR #57, sans créer de tâche ni de PR.
La clôture n'est pas effectuée automatiquement : demander la revue finale du SHA et des limites avant toute validation/clôture humaine.
