# Migration et limites de validation

## Source et couverture

Source figée : `startpointcorporate/konetag@c25c1ac5d42d0e173b9dec28c950617d109d0530`.

Les 305 fichiers de `www/frontend-konektag/src/pages/api` fournissent 305 chemins et 390 opérations HTTP. Aucun endpoint public n'a été supprimé pour cause de similitude. Le manifeste associe chaque module extrait à son fichier source et à l'empreinte du source. Les outils MCP comptent 28 ERPNext/Postiz/CPM, 6 M365 et 8 Unipile ; leurs signatures et corps AST sont vérifiés par les tests.

Les imports ont été réécrits selon le graphe de dépendances réel. `lib/application`, `lib/domain`, `lib/infrastructure` sont déplacés vers les couches correspondantes. Les petits modules transversaux nécessaires sont sous `src/application/shared`. Les implémentations métier restent celles du source. Les dépendances Node reprises sont épinglées aux versions directes du lockfile source. Les nouvelles dépendances servent au transport HTTP, à la documentation et à la compilation.

## Adaptations exécutées

- Les handlers utilisent `RouteHandler` et `RequestContext`, construits sur `Request`/`Response` standard. Le serveur conserve les octets des webhooks, le streaming, les paramètres dynamiques, les cookies multiples et les redirections des API.
- Les références de configuration `import.meta.env` deviennent `process.env`. Les types de contexte ne dépendent plus du framework frontend.
- Le middleware conserve ses sections API : authentification, rafraîchissement de session, restrictions de compte/KYC, blocages financiers et idempotence. Le routage HTML et les réécritures de pages sont exclus.
- Le dispatcher outbox ne démarre plus depuis le middleware **ni depuis le bootstrap importé par certaines routes**. L'outbox et la comptabilité disposent de processus distincts. Les sept programmes planifiés sont compilés indépendamment ; ils ne sont pas exécutés pendant l'installation ou les tests de migration.
- Le modèle de page marchand a été réduit aux déclarations de données `PublicMerchantProjection` et `MerchantPublicationSnapshot` réellement utilisées par le service. Les catalogues de pages et leurs sérialisations sont exclus ; seuls les messages effectivement renvoyés par les API et les documents légaux restent présents.
- La readiness Redis avait un défaut existant : elle ignorait le booléen renvoyé par `ping()`. Elle le respecte désormais ; les tests couvrent explicitement le retour `false`.
- Le chemin de l'image binaire de secours de l'API photo est indépendant d'un répertoire de build frontend.
- Les copies Docker appartiennent explicitement aux utilisateurs non privilégiés des conteneurs, y compris lorsque les fichiers source ont des droits locaux restrictifs. Les quatre images ont été démarrées pour vérifier cette contrainte.
- Le mot de passe de secours Directus a été retiré : fournir le secret existant via la configuration.
- Les MCP gardent OAuth, les confirmations et leurs outils. Le chemin public, le stockage OAuth et les ports sont configurables. Un alias de découverte RFC 8414 réutilise le handler de métadonnées existant lorsque l'issuer a un préfixe ; la version installée du SDK ne publiait pas spontanément cette URL. Les tests couvrent `/m365` et `/unipile`.
- Cinq mocks MCP n'acceptaient pas l'argument positionnel `doctype`. Un sixième simulait `request()` alors que l'appel utilisait le transport HTTP des métadonnées Frappe. Ces fixtures ont été corrigées sans retirer leurs assertions métier ; le transport est désormais simulé sans réseau externe.
- Les tests financiers additionnels conservent les assertions du source. Un mock de l'ancien module de recharge, absent du graphe runtime, a été retiré ; les assertions garantissent toujours que le chemin retiré n'est jamais appelé.

## Mutualisation conservée

L'API et ses workers utilisent les mêmes services, projections, repositories, évaluations d'idempotence, intégrations PSP et adaptateurs. `CPMClient` appelle les mêmes API REST de tarification et de modification des prix que les autres clients ; aucune règle parallèle n'a été créée côté Python.

Les autres connecteurs MCP Python sont les implémentations existantes. Leur réécriture en TypeScript n'apporterait pas de mutualisation métier démontrée et n'a pas été entreprise.

## ERPNext multi-sites

Le source fournit des configurations `ERPNEXT_URL` et `FRAPPE_URL` et un contexte d'entité légale. Il ne définit pas un aiguillage explicite entre trois sites indépendants Congo/Europe/Liban. Ce routage **reste à définir** pour les opérations qui doivent traverser ces sites. Aucun regroupement des trois sites en sociétés d'une même instance n'a été introduit. Les outils historiques acceptant une Company conservent ce contrat dans le site configuré, sans changer de site implicitement.

Avant de déployer, associer chaque processus à ses accès existants et valider les cas multi-sites avec leur contexte métier. Aucun test n'a écrit sur ERPNext.

## Ce que les preuves ne couvrent pas

- Aucun accès applicatif PostgreSQL, Valkey, ERPNext, PSP, Graph, Unipile, Postiz ou S3 n'est configuré dans cette machine. Les tests de non-régression utilisent des doubles. La validation HTTP vérifie explicitement que l'API renvoie une dépendance dégradée lorsque les ressources sont absentes. Elle ne démontre pas une transaction métier réelle.
- Les workers ont été démarrés séparément avec une base locale volontairement indisponible. Aucun événement, paiement, projection, notification, purge ou synchronisation n'a été exécuté sur une plateforme réelle.
- Le YAML OpenAPI couvre toutes les méthodes et chemins. Les schémas détaillés sont extraits des objets littéraux et des validations Zod locales ; les réponses calculées et certains validateurs importés restent non contraints. Une validation des contrats complets contre les ressources intégrées reste nécessaire avant publication d'un contrat strict.
- Les tests exclusivement frontend, service worker, rendu ou infrastructure historique hors périmètre n'ont pas été migrés. `docs/test-migration.json` donne la sélection explicite ; il ne présente pas ces tests comme réussis.
- Les manifests ont été rendus et validés par Helm. Aucun cluster K3s n'est connecté, aucun rollout ni rollback réel n'a été effectué. Les Secrets, PVC, certificat M365 et accès registre doivent exister dans le cluster cible.
- Les jobs existants restent désactivés dans le chart jusqu'au transfert de leur planification. Le contrôle opérationnel global continuera de signaler des preuves manquantes ou d'une autre version tant que ces contrôles n'auront pas été exécutés par leurs propriétaires.
- Les images construites localement ne sont pas publiées au registre. Le workflow manuel réalise cette publication avec le SHA Git après configuration explicite de l'environnement GitHub.

Ces limites ne sont pas contournées par des credentials inventés, une désactivation OAuth ou des règles métier simplifiées.
