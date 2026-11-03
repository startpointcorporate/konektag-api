# Runner HTTP réel — exécution ultérieure sur VPS3

Le point d'entrée réutilise le moteur de la PR #8. Il n'importe ni serveur, ni handler, ni suite Vitest. Il appelle uniquement l'API déjà déployée et lit les observateurs configurés. Aucun serveur, conteneur, port-forward, worker, MCP, migration ou ressource Kubernetes n'est créé.

Le catalogue comporte **392 opérations et une seule définition de scénario par opération**, alias compris. **78 scénarios réutilisent les cas déjà rédigés** dans le brouillon ; **314 sont des scénarios paramétrés sur une fixture réelle** : appel de l'opération, comparaison de son contenu métier attendu et, pour les mutations, observation SQL de son effet persistant. Ces 314 liaisons de données et leurs oracles sont obligatoires avant de pouvoir les exécuter. Leur présence dans le catalogue ne signifie ni fixture disponible, ni scénario métier individuellement revu, ni validation fonctionnelle acquise. Les scénarios existants peuvent représenter un refus métier plutôt qu'un parcours positif.

Aucun test, scénario HTTP ou contrôle des services n'a été exécuté pour cette livraison. La matrice historique de couverture reste inchangée. Les défauts applicatifs, notamment le faux succès possible de send-otp, ne sont pas corrigés par le runner.

## Paramètres indispensables

Copier les exemples dans un répertoire privé hors Git, puis renseigner les données réelles. Les noms des variables d'environnement sont configurables ; les valeurs secrètes ne sont jamais écrites dans le catalogue.

| Paramètre | Quand indispensable | Valeur à fournir |
|---|---|---|
| `baseUrl` | Toujours | Origine HTTP(S) de l'API existante accessible depuis VPS3, sans chemin, query, credentials ni fragment. HTTPS conserve la vérification TLS. HTTP permet un Service K3s déjà accessible. |
| `fixtures` | Toujours | Chemin du JSON privé, relatif au fichier de configuration. |
| `postgresql.urlEnv` | Campagne complète, acteurs et oracles SQL | Nom de la variable contenant l'URL de la base applicative existante, avec un compte d'observation ayant SELECT sur les tables concernées. Connexions et transactions forcées en lecture seule. |
| `actors.<nom>.testOnly` | Chaque acteur utilisé | `true` pour un compte de recette existant. |
| `actors.<nom>.userId`, `.keycloakId`, `.username`, `.role` | Chaque acteur utilisé | Identité réelle PostgreSQL/Keycloak et rôle correspondant. Le sujet du token et la ligne PostgreSQL doivent correspondre. |
| `actors.<nom>.tokenEnv` | Chaque acteur utilisé | Nom de la variable contenant son access token utilisateur Keycloak valide ; aucun token client_credentials. |
| `resources.<nom>.testOnly` et champs de la ressource | Cas rédigés utilisant cette ressource | `true`, identifiants et champs listés dans `fixture-requirements.json`. Les gardes SQL du dépôt contrôlent le propriétaire. |
| `vars.<nom>` | Variables métier listées dans `fixture-requirements.json` | Données réelles complémentaires : `customer.userId/username`, `mail.recipient`, `publicProfile.city/country`, `taxonomy.categoryId`, selon l'opération. Acteurs et ressources sont également disponibles comme variables. |
| `cases.<clé>` | Chacun des 314 cas paramétrés sélectionnés | Liaison décrite ci-dessous. La clé exacte et les paramètres de chemin figurent **pour chaque opération** dans `fixture-requirements.json`. |
| `allowFixtureWrites` | Scénarios avec écriture et cas paramétrés | `true` pour exécuter la campagne sur les seules données de recette désignées. Les GET paramétrés sont aussi soumis à ce paramètre : certains GET applicatifs ont des effets persistants. |
| `valkey.urlEnv` | Scénario send-otp | Nom de la variable contenant l'URL Valkey/Redis existante, pour observer `otp:<email>`, son TTL et le compteur de tentatives. Aucun PING ni écriture directe. |
| `resend.apiKeyEnv` | Scénarios avec preuve d'envoi | Nom de la variable contenant une clé réelle permettant de lire le journal Resend. |
| `resend.testRecipients` | Ces mêmes scénarios | Liste exacte des boîtes de recette autorisées, vérifiée avant tout envoi HTTP. |
| `internalTokenEnv` | Requête utilisant `internalToken: true` | Nom de la variable contenant le token interne existant. |
| `request.headerEnv.<entête>` | Authentification spécifique ou webhook signé | Nom de la variable contenant la valeur réelle de l'entête : clé marchande, signature fournisseur, cookie spécifique, etc. Le corps signé est fourni dans `request.raw`, sans re-sérialisation. |

Les seuls paramètres facultatifs du moteur sont `timeoutMs` (15000), `outputDirectory` (`work/rest-live-results`), `operations` (liste exacte `METHOD /path`), `domains`, `postgresql.caEnv` (nom de variable contenant la CA PEM), `resend.baseUrl` (origine Resend existante, défaut `https://api.resend.com`) et `actors.<nom>.auth` (`bearer`, ou `cookie` pour utiliser le cookie applicatif existant). Aucun nom DNS K3s, namespace ou adresse VPS n'est supposé ni recherché.

### Liaison d'un scénario paramétré

`cases.<clé>` doit contenir :

- `testOnly: true`, `owner`: nom d'un acteur de recette existant ; `actor` est facultatif pour les routes publiques et désigne sinon l'identité HTTP.
- `request`: `params` contenant chaque variable de chemin, `query` si nécessaire et `body` JSON, `raw` ou `form` selon le contrat réel. Pour un upload existant, une valeur de `form` peut être `{ "file": "chemin/prive/document.pdf", "type": "application/pdf" }`, relative au fichier de configuration. `headerEnv` permet les entêtes secrets ; `headers` les entêtes non secrets.
- `expected.status`: statut de succès 2xx attendu ; `expected.body` (sauf réponse 204) : contenu métier attendu comparé comme sous-objet, avec valeurs réelles et au moins un champ. Les listes sont comparées avec leur cardinalité et ordre. Pour les réponses texte/binaire/SSE, utiliser respectivement `request.text`, `request.binary` ou `request.sse` (nom de l’événement, par exemple `payment_status` ; `true` signifie `status_update`) ; l'attendu binaire porte sur `sha256` et/ou `prefix`.
- `oracles`: obligatoire pour une mutation. Chaque observation contient `sql` (une seule requête SELECT/WITH), `params` liés et `equals` (lignes attendues), ou `responsePath` (JSON Pointer à comparer aux lignes). Les options existantes `single`, `column`, `mode` (`subset`, `contains` ou égalité) permettent de comparer la projection HTTP aux données réelles. Ne pas utiliser un SELECT constant comme preuve d'une mutation.
- `preconditions` et `cleanup` si nécessaires à l'état de recette. Les préconditions sont des observations SQL avec `equals` ou `minRows`. Les compensations sont des requêtes HTTP du même format que les étapes rédigées (`method`, `path`, `actor`, `status`, `body`, `assertions`...), exécutées en ordre inverse, même après échec. Les références `${captured.nom}` et `request.capture` permettent de nettoyer uniquement les ressources nouvellement créées. Une opération irréversible exige une fixture consommable dédiée ; le runner ne simule jamais son annulation.

Les variables `${owner.userId}`, `${merchant.id}`, etc. sont résolues depuis les fixtures. `${run.id}` est généré, comme les captures : ne pas les configurer. Une clé d'idempotence unique est ajoutée à chaque commande si aucune n'est fournie. Pour un replay métier explicite, fournir la même clé dans les étapes concernées. Les gardes applicatifs, restrictions KYC, droits administrateur et portée d'entité légale restent ceux de l'API ; un refus inattendu est un échec, pas un contournement.

Les oracles privés sont une configuration exécutable de confiance, limitée par PostgreSQL à la lecture seule. Ne jamais stocker de secrets ou de données personnelles réelles dans les fichiers suivis.

## Dépendances issues du code

`scenarios.json` associe chaque opération à son handler, son empreinte, la fermeture transitive de ses imports et ses services possibles. `dependencies.json` donne pour chaque fichier les services identifiés, variables d'environnement référencées et empreinte ; il décrit aussi le middleware partagé séparément. Les références sont conservatrices : imports de types et branches conditionnelles inclus ; elles ne prouvent ni invocation pour ce scénario, ni disponibilité du service. Aucun healthcheck ou appel de découverte n'est effectué par le runner.

Les URLs et credentials PostgreSQL, Keycloak, Valkey, Frappe/ERPNext, MinIO/S3, Resend, Stripe, PawaPay, Dify, Directus, etc. **utilisés par l'application restent ceux de son déploiement existant**. Le fichier de dépendances fournit leurs noms exacts tels que référencés par le code ; ce n'est pas une liste de variables toutes obligatoires à recopier dans le runner. Celui-ci a seulement besoin de l'origine API, des identités de recette et des accès d'observation indiqués ci-dessus. Il ne reconfigure aucun de ces services.

## Commande réservée à l'exécution ultérieure

Depuis le checkout de cette branche sur VPS3, avec les dépendances Node déjà installées et les variables choisies présentes dans l'environnement :

```sh
node tests/rest/live-draft/rest-live.mjs --config /chemin/prive/rest-live.json
```

**Commande non exécutée pour cette livraison.** Aucun workflow n'appelle ce runner. Les rapports privés JSON/Markdown sont produits uniquement lors de cette future exécution. Une fixture manquante vaut BLOCKED, jamais PASS. Codes de sortie : 0 si toute la campagne passe ; 1 pour échec métier/nettoyage ; 2 pour configuration, blocage ou opérations non exécutées. Une sélection partielle ne vaut pas validation de la campagne complète.

Le catalogue peut être régénéré depuis le code avec `python3 tests/rest/live-draft/build-live-catalog.py` ; cette génération ne lance aucun test et ne contacte aucun service.
