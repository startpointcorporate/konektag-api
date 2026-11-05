# Konektag — CPM quotidien, société propriétaire du marché et estimation

## Contrat commercial

Le simulateur donne **une estimation non contractuelle**. Les CPM sont variables : enchères, audience, objectifs, saisonnalité et zone de diffusion. Ni le coût de diffusion ni les impressions/résultats ne sont garantis. Le prix commercial ERPNext demeure le **prix approuvé** (majoration de service déjà comprise) ; les CPM observés ne sont jamais automatiquement publiés comme Item Price.

Deux séries indépendantes :
1. **Commerciale** : `merchant_social_boost_pricing` lie chaque pays cible, canal, liste de prix et société facturante ; ERPNext Item Price reste la seule référence de devis.
2. **Observation** : `social_cpm_daily_observations` collecte une mesure historique `spend/impressions × 1000` sur les **comptes publicitaires autorisés**, dans la devise native du compte.

### Propriété des marchés (routage)

Le pays **ciblé par la campagne** détermine exclusivement la société qui fournit et facture la prestation. Le pays de domiciliation du commerçant ne doit pas réaffecter le marché publicitaire.

Exemples de politique à **configurer explicitement** dans `merchant_social_boost_pricing`, jamais à déduire du préfixe d'un article :
- Europe (ex. France `FR`, Belgique `BE`, etc.) → **Konektag Europe** ;
- Pays CEMAC (`CG`, `CM`, `GA`, `TD`, `CF`, `GQ`) → **Konektag Congo** ;
- Liban (`LB`) → **Konektag Lebanon**.

Il faut vérifier les noms réels des sociétés ERPNext et la légalité/facturation avant d'activer les mappings. Les listes ci-dessus sont des exemples d'affectation commerciale et non une migration automatique de contrats. Un pays cible sans société active ou lié à plusieurs sociétés est **refusé**. Le même propriétaire doit être utilisé pour toutes les plateformes d'un pays. `resolveTargetBoostCpm` applique ce contrat aux devis clients et à l'API publique.

La réponse publique `GET /api/public/boost-cpm` conserve `countries` pour compatibilité, et ajoute `markets` : groupes `{billingCompany,targetCountries:[{code,name,channels}]}`, ainsi que `guaranteed:false`. Un pays n'est visible que pour ses canaux au tarif ERPNext vérifié. Aucune valeur fictive n'est utilisée pour masquer une erreur.

## Batch quotidien de CPM observés

Le job `dist/jobs/cpm-daily.mjs` est ajouté au build existant et déclaré dans le Helm `jobs.cpm-daily` (**désactivé par défaut**). Cadence proposée : **05:15 UTC chaque jour**, calcul des campagnes livrées la veille, avec un seul job simultané via `concurrencyPolicy: Forbid` et verrou PostgreSQL. La fenêtre de collecte est datée (rejouable par `CPM_OBSERVATION_DAY=YYYY-MM-DD`). Un UPSERT unique par jour/compte/pays/plateforme rend les relances idempotentes.

Les données viennent exclusivement de :
- **Meta Marketing API Insights** (comptes autorisés), dépense, impressions et breakdown pays / Facebook ou Instagram ;
- **TikTok Ads Reporting API** (comptes autorisés), dépense, impressions, pays cible.

Les comptes, permissions, tokens et dépenses réelles sont **nécessaires**. Il n'existe pas de prix d'enchère universel accessible chaque jour pour tous les pays sans campagnes. Un marché ou réseau sans campagnes livrées n'a pas de CPM observé ; aucune estimation nationale n'est fabriquée. Le CPM doit être pondéré par les impressions, pas moyenné arithmétiquement. Les campagnes dans des devises différentes ne sont jamais agrégées sans conversion documentée.

### Configuration sécurisée

Le Secret Kubernetes **existant** référencé par `api.existingSecret` doit fournir :
- `DATABASE_URL` et les accès applicatifs PostgreSQL préexistants ;
- `KONEKTAG_CPM_ACCOUNTS_JSON` : métadonnées des comptes autorisés (jamais les tokens dans le JSON) ;
- les variables de token nommées dans ce JSON, par exemple `KONEKTAG_CPM_META_EU_TOKEN` et `KONEKTAG_CPM_TIKTOK_CG_TOKEN`.

Structure **illustrative uniquement**, les sociétés et identifiants doivent provenir des comptes réellement autorisés :

```json
[
  {"billingCompany":"<nom ERPNext de la société européenne>","platform":"meta","accountId":"<id numérique>","tokenEnv":"KONEKTAG_CPM_META_EU_TOKEN","currency":"EUR"},
  {"billingCompany":"<nom ERPNext de la société congolaise>","platform":"tiktok","accountId":"<id numérique>","tokenEnv":"KONEKTAG_CPM_TIKTOK_CG_TOKEN","currency":"USD"}
]
```

Les variables sensibles ne doivent jamais être commitées. Ne pas utiliser le compte d'une société pour recueillir ou facturer les statistiques d'un autre marché. Le batch accepte uniquement les observations dont le pays cible appartient **sans ambiguïté** à la société de facturation configurée. Les identifiants de comptes sont hachés dans le journal PostgreSQL ; les accès et tokens ne sont pas journalisés.

### Activation — ordre obligatoire

1. **Auditer** la table des mappings actifs pays/canal/société et résoudre chaque conflit. Confirmer les articles et Item Price ERPNext.
2. Appliquer la migration additive `226_social_cpm_observations.sql` via la procédure de migration existante (qui protège la production), **sans modifier les anciennes migrations**.
3. Autoriser et connecter les comptes Meta/TikTok, tester leurs permissions Insights et Reporting sur une journée comportant des campagnes, vérifier le pays et la devise retournés.
4. Déployer l'API et son exécutable `dist/jobs/cpm-daily.mjs` ; exécuter **une collecte manuelle** et réconcilier les totaux avec les gestionnaires publicitaires.
5. Activer `jobs.cpm-daily.enabled=true` par Helm **seulement après** validation des comptes, de la base et des permissions ; conserver le planning à `15 5 * * *`.
6. Vérifier les logs, le nombre de lignes insérées et les anomalies. En cas d'absence de données, afficher « Données observées indisponibles » et continuer avec le dernier CPM **commercial validé**, jamais avec une valeur reconstituée.

### Contrôle qualité

- Alerter si variation de CPM observé supérieure à 15 % sur une fenêtre comparable et un volume suffisant ; **ne pas appliquer automatiquement** la variation au prix ERPNext.
- Vérifier en amont la compatibilité du breakdown pays/placement avec les comptes Meta et TikTok réels ; certaines dimensions changent selon la version de leur API.
- Aucun job ne doit créer ou modifier des prix commerciaux, de devis, de campagnes ou d'ordres publicitaires.

Références techniques : Meta Marketing API Insights, TikTok API for Business `/open_api/v2.0/report/integrated/get/` (dimensions `country_code`, métriques `spend` et `impressions`), et règles ERPNext déjà dans `merchant-social-boost-price-resolver.ts`.
