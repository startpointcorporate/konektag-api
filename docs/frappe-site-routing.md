# Routage Frappe des parcours Konektag

Les quatre parcours publics et membres choisissent leur site Frappe côté serveur, toujours de la même façon :

```
pays de résidence → payment_country_mappings (règle active) → pays de rattachement → konektag-<pays> → site Frappe
BE → FR → konektag-fr → EUROPE (europe.erp.konektag.eu)
CG → CG → konektag-cg → CONGO  (congo.erp.konektag.eu)
LB → LB → konektag-lb → LIBAN  (liban.erp.konektag.eu)
```

Le résolveur partagé est `src/application/shared/konektag-site.ts`. Le navigateur n'envoie qu'un pays ; il ne choisit
jamais un site. Il n'y a aucun repli : une règle ou un site manquant renvoie une erreur explicite.

| Code | HTTP | Cause |
|---|---|---|
| `RESIDENCE_COUNTRY_INVALID` | 422 | pays absent ou illisible |
| `COUNTRY_RULE_NOT_FOUND` | 422 | aucune règle active pour ce pays |
| `COUNTRY_RULE_AMBIGUOUS` | 503 | plusieurs règles actives |
| `COUNTRY_RULE_OUTSIDE_KONEKTAG` | 503 | la règle ne mène pas à FR, CG ou LB |
| `KONEKTAG_SITE_NOT_CONFIGURED` | 503 | slug sans `site`, ou site sans URL / identifiants |

Le paiement préfixe ces codes par `PAYMENT_CONTEXT_` (par exemple `PAYMENT_CONTEXT_KONEKTAG_SITE_NOT_CONFIGURED`).
Chaque appel routé écrit une ligne `[konektag-site] {"flow":…,"residenceCountry":…,"paymentCountry":…,"slug":…,"site":…}`.

## Configuration

`MARKETPLACE_TRANSACTION_MERCHANTS` accepte un `site` au niveau du slug. Les blocs `restaurant` et `hotel` restent inchangés.

```json
{
  "konektag-fr": { "site": "EUROPE" },
  "konektag-cg": { "site": "CONGO" },
  "konektag-lb": { "site": "LIBAN" },
  "<slug restaurant>": { "restaurant": { "site": "RESTODEMO", "posProfile": "…" } }
}
```

Chaque site lit `MARKETPLACE_FRAPPE_<SITE>_URL`, `_API_KEY` et `_API_SECRET`. Les identifiants restent dans des Secrets.
Le propriétaire des Leads reste propre à l'entité : `KONEKTAG_MEETING_<FR|CG|LB>_LEAD_OWNER` et, si l'axe est
exigé par le site, `KONEKTAG_MEETING_<FR|CG|LB>_DEFAULT_AXIS`.

`ERPNEXT_CG_*`, `ERPNEXT_FR_*` et `ERPNEXT_LB_*` ne sont plus lus : les supprimer du Secret `konektag-api-env`
une fois les sites EUROPE et LIBAN configurés.

## Règles de pays (migration 231)

Toutes les règles actives doivent mener à FR, CG ou LB ; la migration échoue sinon. Elle ajoute `LB → LB` et rattache à
CG les pays AO, CD, CF, CM, GA, GN, GQ et TD, qui pointaient vers eux-mêmes sans site Konektag. Les anciennes lignes
sont gardées en `INACTIVE`. Ces règles servent aussi aux prix Pro, au KYB et aux documents légaux.

## Parcours

| Parcours | Pays utilisé | Site appelé |
|---|---|---|
| Présenter mon projet (`POST /api/public/commercial-request`) | `country`, code ISO ou nom français/anglais | Lead créé ou mis à jour |
| Demander un rendez-vous (`GET /api/meeting-slots`, `POST /api/meeting-request`) | `country`, code ISO de résidence | créneaux, Lead et `Appointment` sur un seul site résolu une fois par requête |
| Inscription (worker `UserRegistered`) | `legalCountry` de l'événement, sinon `users.legal_country` | Contact retrouvé par `konektag_user_id`, puis consentement |
| Achat de Points K (`POST /api/pay/recharges`) | `users.legal_country` de l'acheteur ; le `paymentCountry` du corps est ignoré | contexte de paiement et frais lus avant la création du checkout |

Le fuseau d'un rendez-vous est celui de l'entité résolue (`Europe/Paris`, `Africa/Brazzaville`, `Asia/Beirut`).
Les réponses portent `konektagSite` (slug) pour la recette.

Pour l'achat de Points K, la réponse renvoie `paymentContext` : pour chaque moyen de paiement, les frais et le
`selectionToken` signé qui les contient, avec le slug du site. La commande garde `order_metadata.konektagSite.slug`.
Au financement, une sélection lue sur un autre site est refusée (409) : les frais affichés sont ceux du checkout.
`GET /api/pay/payment-context` passe par le même routage. Une devise différente de celle de l'entité renvoie
`409 PAYMENT_CURRENCY_MISMATCH`. Les règles de calcul des frais ne changent pas.

L'identifiant du Contact est propre à chaque site : `users.erpnext_contact_id` (ancien site unique) n'est pas écrit.

## Recette

`tests/unit/konektag-site-routing.test.ts` simule un Frappe par hôte et vérifie, pour chaque parcours, le site
effectivement appelé : BE → konektag-fr, CG → konektag-cg, LB → konektag-lb ; créneau affiché et `Appointment` du même
site ; frais affichés égaux à ceux signés pour le checkout.
