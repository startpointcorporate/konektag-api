# Routage Frappe des parcours Konektag

Les quatre parcours publics et membres choisissent leur site Frappe côté serveur, toujours de la même façon :

```
pays de résidence → payment_country_mappings (règle active) → pays de rattachement → konektag-<pays> → site Frappe
BE → FR → konektag-fr → EUROPE      (europe.erp.konektag.eu, api-europe@konektag.eu)
CG → CG → konektag-cg → KONEKTAG_CG (congo.erp.konektag.eu,  api-congo@konektag.eu)
LB → LB → konektag-lb → LIBAN       (liban.erp.konektag.eu,  api-lebanon@konektag.eu)
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
  "konektag-cg": { "site": "KONEKTAG_CG" },
  "konektag-lb": { "site": "LIBAN" },
  "<slug restaurant>": { "restaurant": { "site": "RESTODEMO", "posProfile": "…" } }
}
```

Chaque site lit `MARKETPLACE_FRAPPE_<SITE>_URL`, `_API_KEY` et `_API_SECRET`. Les identifiants restent dans des Secrets.
`konektag-cg` a sa propre clé `KONEKTAG_CG` : la clé `CONGO` est le compte Link Pay, sans droit sur Lead, Appointment
ni Appointment Booking Settings. L'API **et** le worker outbox (`konektag-api-outbox`, qui traite `UserRegistered`)
doivent recevoir ces variables ; elles ne sont lues qu'au démarrage du pod.

Bascule : l'ancienne API rejette le champ `site`. Le retour arrière remet d'abord l'ancien JSON, redémarre les pods,
puis seulement réactive l'ancienne version.
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
| Inscription (worker `UserRegistered`) | `legalCountry` de l'événement, sinon `users.legal_country` | Contact retrouvé par `konektag_user_id`, puis consentement ; un échec est rejoué par l'outbox (backoff, puis dead-letter), sans doublon |
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

## Données de paiement

Au financement, les données de la sélection signée (entité, acteur, profil) sont projetées depuis le site Konektag où elle
a été lue, plus depuis `ERPNEXT_URL`. `POST /api/admin/regulatory-projections/{type}/{code}?country=FR` projette depuis
le site de ce pays. Elles sont livrées par `konektag_360` (DocTypes `Konektag Legal Entity`, `Corridor`, `Regulated Actor`,
`Regulatory Profile`) ; frais d'achat de départ : 4 % (`fee_percentage_bps = 400`) sur chaque site.

## Prérequis Frappe relevés le 2026-11-10 (lecture seule)

- `Konektag Legal Entity`, `Konektag Regulatory Profile`, `Konektag Corridor` et `Konektag Regulated Actor`
  n'existent sur aucun des trois sites (app `konektag_foundation` non installée) : l'achat de Points K et
  `payment-context` répondent `PAYMENT_CONTEXT_FRAPPE_UNAVAILABLE` tant que ces données ne sont pas sur chaque site.
- Les champs Contact de l'inscription (`konektag_user_id`, `legal_country`, `accepted_terms`, `terms_*`, `privacy_*`)
  n'existent sur aucun site.
- Les champs Lead `custom_axis`, `custom_commercial_stage`, `custom_next_action`, `custom_next_action_date`,
  `custom_activity_summary` utilisés par « Présenter mon projet » n'existent sur aucun site.
- Droits : Contact create/write accordés aux trois comptes ; Lead et Appointment create vérifiés sur EUROPE,
  non vérifiables sur LIBAN et Congo (aucun document existant).
