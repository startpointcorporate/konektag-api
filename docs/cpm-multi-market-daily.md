# CPM mensuels Konektag — import JSON et simulateur

**Modèle simple :** une fourchette CPM `cpmLow / cpmHigh` par **société Konektag, pays ciblé et réseau social**. Le simulateur calcule les impressions indicatives `floor(budget * 1000 / cpmHigh)` à `floor(budget * 1000 / cpmLow)`. **Aucune impression ni performance n'est garantie.**

## Source et responsabilité des marchés

- **Konektag Europe** pour les pays d'Europe attribués, **Konektag Congo** pour les pays CEMAC attribués, **Konektag Lebanon** pour le Liban. Ce sont des règles commerciales à définir, non un transfert automatique de contrats.
- L'import compare la société dans le JSON aux mappings actifs de `konektag.merchant_social_boost_pricing` ; un marché absent, partagé entre sociétés ou attribué à une autre société est refusé. Il faut d'abord configurer le pays et sa société propriétaire dans le back-office.
- Un client au Congo ciblant la France utilise le **marché Konektag Europe**, pas Konektag Congo.
- `GET /api/public/boost-cpm` agrège les fourchettes par société dans `markets`, avec une liste `countries` conservée pour le Web. L'API ne fabrique aucune valeur en l'absence d'import.

## JSON mensuel

Créer un fichier local, par exemple `cpm-2026-11.json`, contenant :

```json
{
  "month": "2026-11",
  "rates": [
    {
      "billingCompany": "Konektag Congo",
      "targetCountry": "CG",
      "countryName": "Congo",
      "network": "facebook",
      "currency": "XAF",
      "cpmLow": 1000,
      "cpmHigh": 1500
    }
  ]
}
```

**Les valeurs 1 000/1 500 ci-dessus sont uniquement des exemples, pas des tarifs du Congo.** Fournir les véritables valeurs validées par Konektag avant tout import. Répéter une ligne pour chaque couple pays/réseau (Facebook, Instagram, TikTok). Les montants représentent les **CPM commerciaux finaux, frais de service inclus** : ne jamais ajouter de second supplément dans le simulateur. Tous les CPM d'un pays appartiennent à la même société. Les devis et factures réels continuent d'utiliser les Item Price ERPNext approuvés : ce tableau est réservé à l'estimation.

## Exécution (audit avant écriture)

1. Déployer la migration additive `226_social_cpm_observations.sql` (nom hérité, contenu = table `social_cpm_monthly_ranges`) selon le processus contrôlé existant.
2. Monter le fichier JSON du mois dans le conteneur opérateur avec accès à `DATABASE_URL`.
3. **Vérifier sans écriture** : `node dist/jobs/cpm-monthly-import.mjs /absolute/path/cpm-2026-11.json`.
4. **Importer après validation** : `node dist/jobs/cpm-monthly-import.mjs /absolute/path/cpm-2026-11.json --apply`.
5. Tester `GET /api/public/boost-cpm` et les calculs sur Web.

- Les imports sont **transactionnels**, idempotents pour un fichier strictement identique, et refusent une seconde version différente du même mois. Les corrections après approbation nécessitent une procédure métier explicite ; elles ne peuvent pas écraser silencieusement l'historique.
- Un mois sans nouveau fichier conserve les dernières fourchettes disponibles par pays/réseau : celles du mois courant ou précédent restent utilisables ; celles de deux mois portent `stale: true` ; au-delà de deux mois, elles ne sont plus exposées au public. Les réponses indiquent toujours `referenceMonth`.
- **Pas de cron mensuel automatique** : on exécute le batch quand le fichier mensuel est fourni. Aucun compte publicitaire ni token Meta/TikTok n'est requis.
- La collecte quotidienne API Meta/TikTok a été supprimée et le CronJob `cpm-daily` retiré de Helm.

## Contrat public de simulation

- `GET /api/public/boost-cpm` : données indicatives par pays et réseau, uniquement pour les marchés ayant **une seule société propriétaire active** dans `merchant_social_boost_pricing`. L'absence de tarif valide signifie qu'aucune estimation ne doit être proposée.
- `POST /api/public/boost-estimate` : `{"targetCountry":"CG","network":"facebook","budget":20000,"currency":"XAF"}`. Le budget est un **montant commercial entier dans la devise du benchmark** (frais Konektag déjà inclus). Le service ne fait pas de conversion implicite et n'accepte aucune société de facturation envoyée par le navigateur.
- Retour : `estimatedImpressions: {min, max}`, `billingCompany`, `referenceMonth`, `stale`, `estimated: true`, `guaranteed: false`. `min=floor(budget*1000/cpmHigh)`, `max=floor(budget*1000/cpmLow)`.
- Les impressions ne sont **ni des personnes uniques, ni des clics, ni des conversions** et ne sont jamais garanties.
- L'estimation ne modifie aucun `Item Price` ERPNext ; les devis/commandes conservent leur contrôle commercial et juridique indépendant. La cohérence entre le budget simulé, la prestation achetée et les éventuelles taxes doit être validée lors de l'intégration commande. Les simulations multi-pays et multi-réseaux restent hors du périmètre de cette PR.

## Contrôles avant fusion et mise en service

1. Exécuter `npm run typecheck`, `npm test`, `npm run build` et les tests REST adaptés.
2. Vérifier un fichier JSON réel au format du mois (sans valeur fictive) en dry-run, puis avec `--apply` sur une base de test ayant les mappings marché/société validés.
3. Contrôler la devise de chaque pays et l'unicité de société responsable ; le fichier est refusé si plusieurs réseaux d'un pays utilisent des devises différentes.
4. Tester l'API avec un marché actif, un marché ambigu, un réseau sans tarif et un tarif périmé.
5. Valider séparément le parcours de facturation ERPNext. **Ne pas fusionner/déployer avant que ces contrôles soient verts.**
