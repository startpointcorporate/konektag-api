# Exports quotidiens CPM ERPNext → PostgreSQL

Les trois sites Frappe sont la **source de vérité** des deux bornes CPM. Les tâches quotidiennes s'exécutent indépendamment sur le VPS K3s, lisent `Marketing CPM Rate` via `bench` et écrivent uniquement dans la projection PostgreSQL `konektag.social_cpm_monthly_ranges`. **Konektag API ne contacte jamais ERPNext pour le calculateur.**

## Sites et devises
- `congo.erp.konektag.eu` → `Konektag Congo` → CG/XAF.
- `europe.erp.konektag.eu` → `Konektag Europe` → FR/EUR.
- `liban.erp.konektag.eu` → `Konektag Lebanon` → LB/USD.

## Installation

Utiliser l'installateur unique `install_konektag_cpm.sh` fourni avec le dossier de mise en service, depuis la VM Ubuntu, avec accès SSH `konektag-core`.

```bash
bash install_konektag_cpm.sh --check
bash install_konektag_cpm.sh --install
```

L'installateur crée les tables de provenance et d'audit, lance un premier export, puis inscrit dans `/etc/cron.d/konektag-cpm` trois exports quotidiens (02:10 / 02:20 / 02:30 UTC). Il met les logs dans `/var/log/konektag-cpm/` et installe leur rotation. Il utilise les pods existants `konektag-erpnext-gunicorn` et `postgres-0` sans nouveau secret. L'accès PostgreSQL du VPS doit déjà autoriser `psql -U postgres -d konektag` dans `postgres-0`.

`--check` audite les sites sans écriture PostgreSQL ni modification cron. `--run-all` relance immédiatement les trois exports. Les modifications de prix dans ERPNext sont exportées lors de la prochaine exécution ; un réexport sans changement est idempotent.

La migration `227_cpm_frappe_site_export.sql` décrit le schéma correspondant et peut être appliquée séparément selon le processus normal de migrations. Le script d'installation la rend **idempotente** pour la même version : ne pas créer manuellement une autre table concurrente.

## API public
- `GET /api/public/boost-cpm` : toutes les valeurs publiées.
- `GET /api/public/boost-cpm?country=CG` : valeurs d'un pays.
- `GET /api/public/boost-cpm?network=facebook` : valeurs du réseau dans chaque pays.
- `GET /api/public/boost-cpm?groupBy=network` : vue regroupée dans `networks`, avec `countries` préservé pour rétrocompatibilité.
- `GET /api/public/boost-cpm?country=FR&network=instagram` : combinaison.
- `POST /api/public/boost-estimate` : calcul inchangé depuis PostgreSQL, sans appel Frappe.

Les valeurs comportent `billingCompany`, `erpnextSite`, `itemCode`, `currency`, `cpmLow`, `cpmHigh`, `referenceMonth`, `stale`. Les données âgées de plus de deux mois sont masquées. La synchronisation est tracée dans `cpm_export_runs` et les modifications des bornes dans `cpm_rate_history`.

## Contraintes
- `Item Price` ERPNext n'est ni créé ni modifié.
- Une base Frappe ne peut exporter que son marché configuré.
- La projection n'accepte que les lignes du site propriétaire déclaré dans `cpm_source_sites`.
- La refonte de la facturation ERPNext multi-sites demeure une question distincte du calculateur.
- Ne pas activer les anciens mappings `merchant_social_boost_pricing` simplement pour afficher les CPM.
- **Ordre de mise en service :** appliquer la migration/installer les exports, vérifier leur sortie, puis déployer la nouvelle API après fusion CI verte. Le déploiement GitHub ne migre pas la base.
