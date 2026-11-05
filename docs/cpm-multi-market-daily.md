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
- Un mois sans nouveau fichier conserve les dernières fourchettes disponibles par pays/réseau, avec `referenceMonth`. Il faudra afficher/contrôler leur ancienneté.
- **Pas de cron mensuel automatique** : on exécute le batch quand le fichier mensuel est fourni. Aucun compte publicitaire ni token Meta/TikTok n'est requis.
- La collecte quotidienne API Meta/TikTok a été supprimée et le CronJob `cpm-daily` retiré de Helm.
