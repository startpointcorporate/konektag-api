# Link Pay encaissé par le site Réseau

Un site Frappe émet un lien pour sa propre facture. Il est le **bénéficiaire** et désigne son site
**Réseau**, qui encaisse pour lui. Le nouveau parcours ne lit jamais `konektag.merchant_profiles`.
Les liens déjà émis (profil marchand, BOOST, catalogue) gardent leur parcours actuel.

| Cas | Émetteur = bénéficiaire | Réseau | Webhooks | Reste à verser |
|---|---|---|---|---|
| Commerçant | `RESTODEMO` | `CONGO` | `CONGO`, puis `RESTODEMO` après l'accusé de Congo | net − versements confirmés |
| 360° | `CONGO` | `CONGO` | un seul, rôles `network` + `beneficiary` | 0 (la facture de Congo est soldée) |

## Contrat

`POST /api/integrations/frappe/payment-links`. Le site est authentifié par `X-Konektag-Frappe-Site` et
`X-Konektag-Frappe-Token`, avec `X-Idempotency-Key` (64 hex) propre à chaque tentative.

```json
{ "invoice": "ACC-SINV-2026-00012", "beneficiarySite": "RESTODEMO", "networkSite": "CONGO", "description": "…" }
```

1. Le bénéficiaire doit être le site authentifié ; le Réseau doit avoir `network: true`.
2. La facture est relue sur le site émetteur : soumise, hors retour et hors caisse, monodevise, solde > 0.
3. Les conditions sont relues sur le Réseau (`konektag_360.link_pay.network.beneficiary_terms`). L'API exige,
   sans rien présumer : bénéficiaire actif et approuvé, pays, règle de frais (`Percentage` > 0 ou `Exempt`),
   coordonnées de versement pour un tiers, devise de la facture = devise du pays. Un refus nomme la donnée
   manquante (`missing`), que Frappe traduit en message pour l'administrateur.
4. Ces conditions sont figées dans `link_pay_network_links`.

`GET …?invoice=` renvoie les liens du site. `operationId` n'y apparaît qu'après l'accusé du Réseau.

Paiement (`POST /api/pay/pay-link`) : l'approbation est relue sur le Réseau. Si elle a été retirée, le
paiement est refusé ; si le Réseau est injoignable, la réponse est 503. Dans les deux cas, aucun débit.
Les Points K du payeur sont éteints une seule fois, puis la transaction (brut, frais arrondis au demi
supérieur en unités mineures, net) et ses webhooks sont écrits dans la même transaction SQL. Aucun Point K
n'est crédité au bénéficiaire : le Réseau lui doit un montant en devise.

Webhook `link_pay.payment.succeeded`, `POST <site>/api/method/konektag_360.link_pay.webhook.receive`, signé
`X-Konektag-Signature` = HMAC-SHA256(corps brut, `webhookSecret`). Le transport, la protection SSRF et le
calendrier de reprise (7 tentatives, de 0 s à 24 h) sont ceux des webhooks de paiement API. Une livraison
n'est comptée qu'avec l'accusé `{transactionId, network?, beneficiary?}`. Un site peut redemander une
livraison en échec ou abandonnée : `POST /api/integrations/frappe/link-pay/deliveries {transactionId}`.

## Configuration

```json
LINK_PAY_FRAPPE_SITES = {
  "CONGO":     { "tokenSha256": "<sha256 du jeton de Congo>", "webhookSecret": "<≥ 32 car.>", "network": true },
  "RESTODEMO": { "tokenSha256": "<sha256 du jeton de RESTODEMO>", "webhookSecret": "<≥ 32 car.>" }
}
MARKETPLACE_FRAPPE_<SITE>_URL / _API_KEY / _API_SECRET   (utilisateur Frappe ayant les rôles Link Pay API + Accounts User)
```

## Migration 230

Additive et rejouable. Sur `checkout_intents`, elle ajoute la colonne `collection_route` et étend
`checkout_intents_owner_check` aux seuls liens réseau. Elle crée trois tables et étend la preuve de
consommation `check_link_k_completion`, sans changer la branche marchande.

1. Sauvegarde PostgreSQL de `konektag` (`pg_dump -Fc`), vérifiée par `pg_restore -l`.
2. `psql -X -v ON_ERROR_STOP=1 -f docs/proposals/230-link-pay-network-precheck.sql` : conserver la sortie.
3. Application en une transaction, en tant que propriétaire du schéma :
   ```sql
   BEGIN;
   \i src/lib/infrastructure/database/migrations/230_link_pay_network_collections.sql
   INSERT INTO konektag.schema_migrations (version, filename, checksum)
   VALUES ('230:230_link_pay_network_collections.sql', '230_link_pay_network_collections.sql', '<sha256sum du fichier>');
   COMMIT;
   ```
4. `docs/proposals/230-link-pay-network-postcheck.sql` : chaque requête indique son résultat attendu. Les
   décomptes de liens existants doivent être identiques à l'étape 2.
5. Retour arrière : redéployer l'API précédente, qui n'utilise pas ces objets. Les tables restent vides et
   la contrainte élargie ne concerne que `collection_route = 'frappe_network'`.

Ordre de livraison : migration 230, puis API (déploiement automatique après fusion sur `main`), puis
Frappe (`bench migrate` : DocTypes, rôles, rapport), puis configuration des sites, puis approbation des
bénéficiaires sur le Réseau.

## Validation

- `tests/unit/link-pay-network-routing.test.ts` : authentification, routage, frais, accusé, charge utile.
- `tests/integration/link-pay-network.pg.ts` (PostgreSQL réel, doubles HTTP Frappe) : rejeu de clé, débit
  unique, ordre Réseau → bénéficiaire, cas 360°, Réseau indisponible puis reprise, relivraison, conditions
  manquantes, approbation retirée.
- `konektag_360/scripts/validate-link-pay-e2e.sh <ce dépôt>` : API réelle + PostgreSQL + deux sites Frappe
  réels (`congo.test`, `resto.test`) ; commerçant, 360°, webhooks rejoués, Réseau indisponible, versement.
