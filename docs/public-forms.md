# Formulaires publics : contact et opt-in (KON-109)

Opérations anonymes destinées à tout site client autorisé, sans Web Form Frappe. Le navigateur ne voit jamais
d'identifiant Frappe : il envoie un contexte (`siteId` **ou** `country`), le serveur résout le tenant et son site.
Contrat : `docs/openapi.yaml` (`submitPublicContact`, `requestPublicOptin`, `confirmPublicOptin`, `unsubscribePublicOptin`).

| Opération | Effet Frappe |
|---|---|
| `POST /api/public/forms/contact`, `intent` = `sales` ou `general` | `Lead` retrouvé par e-mail (le plus ancien) ou créé, puis `Communication` reçue rattachée au Lead |
| `POST /api/public/forms/contact`, `intent` = `support` | `Issue` (`raised_by` = e-mail ; ERPNext rattache lui-même Lead/Contact) |
| `POST /api/public/forms/optin` | aucun : e-mail de confirmation (double opt-in) |
| `POST /api/public/forms/optin/confirm` | `Email Group Member` créé inactif, preuve en `Comment`, puis activé |
| `POST /api/public/forms/optin/unsubscribe` | `Email Group Member.unsubscribed = 1`, puis trace du retrait en `Comment` |

## Routage site / pays

`src/application/public-forms/site.ts` est le seul point d'accès au site. `siteId` et `country` sont exclusifs
(`400 SITE_SELECTOR_CONFLICT` / `SITE_SELECTOR_REQUIRED`).

- `country` : routage Konektag publié (`konektag-site.ts`, BE → konektag-fr → EUROPE, CG → KONEKTAG_CG, LB → LIBAN),
  mêmes codes d'erreur. Les règles CRM de l'entité (`KONEKTAG_MEETING_<FR|CG|LB>_LEAD_OWNER`, `_DEFAULT_AXIS`) sont
  appliquées au Lead créé.
- `siteId` (sites clients, par exemple Rocher des Âges, ABM Demo) : `frappeSiteId` du registre
  `KONEKTAG_FRAPPE_SITE_REGISTRY` de KON-107 (voir [frappe-site-routing.md](frappe-site-routing.md)), résolu par
  `resolveFrappeSite` comme un appel anonyme. Aucune URL Frappe libre n'est acceptée.
  - Scope par opération dans `publicScopes` : `contact:write` (contact) et `optin:write` (demande, confirmation et
    désinscription). Un site qui ne publie que `catalog:read` refuse les formulaires (`403 SITE_ACCESS_FORBIDDEN`).
  - Origine : si le navigateur envoie `Origin`, elle doit figurer dans `allowedOrigins` (`403 SITE_ACCESS_FORBIDDEN`).
    Contrat KON-107 : sans en-tête `Origin` (appel serveur), l'origine n'est pas contrôlée ; restent Turnstile et les
    limites de débit.
  - Site inconnu ou désactivé : `404 SITE_NOT_FOUND`, indiscernables ; identifiant mal formé :
    `400 SITE_SELECTOR_INVALID` ; registre invalide ou Secrets `MARKETPLACE_FRAPPE_<SITE>_*` absents :
    `503 KONEKTAG_SITE_NOT_CONFIGURED`.
  - `tenantId` = `tenantId` de l'entrée (`konektag-<pays>` pour `kind: KONEKTAG`), qui sélectionne aussi la
    configuration `PUBLIC_OPTIN_LISTS`. Les règles CRM `KONEKTAG_MEETING_*` ne s'appliquent qu'aux entrées KONEKTAG.
  - Pour un site du registre, les jetons signés et la preuve de consentement portent le `frappeSiteId` public, pas la
    clé interne `site` (une inscription par `country` y garde la clé d'entité, par exemple `EUROPE`). Une entrée
    CUSTOMER dont le `tenantId` commence par `konektag-` est refusée (`503 KONEKTAG_SITE_NOT_CONFIGURED`).
    À la confirmation et à la désinscription, l'entrée doit toujours exister, être active, appartenir au même tenant
    et publier `optin:write`. **Retirer `optin:write` ou désactiver le site bloque donc aussi les désinscriptions par
    jeton** : garder le scope tant que la liste a des membres, ou les désinscrire depuis Frappe.

## Contact

- Validation stricte (champs inconnus refusés), corps JSON ≤ 16 kB, champ piège `website`, Turnstile optionnel
  (action `public-contact`, hôte = `Origin`).
- Limites Redis par tenant : 5/h par e-mail, 120/h par pair TCP, 500/h par site. Le pair est l'adresse de la socket
  (comme `commercial-request`) : derrière un proxy partagé, la limite par pair ne sert qu'à arrêter un flot.
- `name` et `company` ≤ 140 caractères, `phone` limité aux caractères du champ Frappe *Phone* (≤ 20) : une saisie
  invalide répond `400` au lieu d'un rejet du CRM.
- Déduplication : `Lead.email_id` normalisé en minuscules (collation MariaDB insensible à la casse) ; s'il en existe
  plusieurs, le plus ancien (`order_by creation asc`) est utilisé. Si deux demandes simultanées créent le même Lead,
  le refus d'ERPNext est suivi d'une relecture et le Lead existant est réutilisé. Une demande `support` ne crée pas de Lead.
- Campagne : `utm_source`, `utm_medium`, `utm_campaign` ne sont posés sur un **nouveau** Lead que si l'enregistrement
  UTM existe déjà sur le site (un Link absent ferait rejeter le Lead) ; ils figurent toujours dans la Communication,
  avec le site, l'origine, la page et l'heure UTC.
- Réponse : référence opaque `WEB-XXXXXXXXXX`, aussi écrite dans le sujet Frappe. Aucun nom CRM n'est renvoyé et la
  réponse est la même que l'e-mail soit connu ou non.
- Idempotence : la même soumission (ou le même en-tête `Idempotency-Key`) pendant 24 h renvoie `200` et la première
  référence ; une clé réutilisée pour un autre message répond `409 IDEMPOTENCY_KEY_REUSED`. Si la Communication échoue
  après la création du Lead, le nouvel essai réutilise ce Lead.
- **Aucun e-mail n'est envoyé et aucune inscription n'est faite** sur simple contact. Un accusé automatique de l'Issue
  ne dépend que de la configuration Support du site.
- `CRM_REJECTED` (503) : le site refuse l'écriture (droit manquant, champ obligatoire propre au site) ; le journal
  `[public-forms] contact CRM write failed` donne l'étape, le statut HTTP et le type d'exception Frappe.

## Opt-in (RGPD)

- Consentement explicite : `consent.accepted` doit valoir `true` (case non cochée par défaut), avec la version du texte
  affiché. **Le texte vient du serveur** : la preuve et l'e-mail n'emploient jamais un texte fourni par le navigateur
  (version inconnue : `422 CONSENT_VERSION_UNKNOWN`). Publier un nouveau texte = ajouter une version, sans retirer
  l'ancienne tant que des confirmations sont en attente (72 h).
- Listes : le navigateur choisit une clé publique ; le `Email Group` et les textes viennent de la configuration du tenant :

  ```json
  PUBLIC_OPTIN_LISTS = {
    "konektag-fr": {
      "confirmationOrigins": ["https://www.konektag.eu"],
      "lists": { "newsletter": { "emailGroup": "Newsletter Konektag FR",
                                 "consentTexts": { "newsletter-2026-11": "J'accepte de recevoir la newsletter Konektag…" } } }
    }
  }
  ```

  Une liste d'un autre tenant répond `404 OPTIN_LIST_NOT_FOUND`. Le `Email Group` doit exister sur le site
  (`503 OPTIN_LIST_UNAVAILABLE` sinon, avant tout e-mail). `confirmationUrl` doit appartenir à une origine autorisée du
  tenant (`403 CONFIRMATION_URL_NOT_ALLOWED`) : l'API n'envoie jamais un lien vers un domaine tiers.
- Double opt-in systématique : un formulaire anonyme ne prouve pas la propriété de l'adresse. L'app Frappe `newsletter`
  n'est installée sur aucun site (sondes du 2026-11-21), donc ses méthodes invité `subscribe` / `confirm_subscription`
  ne sont pas disponibles. Le lien `confirmationUrl#token=…` porte le jeton dans le **fragment** (absent des journaux
  serveur et du Referer) ; la page le lit et l'envoie à `/optin/confirm` **après un clic** du visiteur (un scanner de
  liens ne doit pas confirmer). Valable 72 h, le jeton n'est stocké dans Redis que sous forme de SHA-256. Rien n'est
  écrit dans Frappe avant la confirmation. Après confirmation, l'entrée Redis ne garde ni adresse ni texte (7 jours).
- Limites : 3 demandes/h par adresse et tenant (protection des tiers contre l'envoi répété), 120/h par pair, 500/h par
  site. Avec `TURNSTILE_SECRET_KEY`, le jeton Turnstile est **obligatoire** pour l'opt-in (il reste facultatif pour le
  contact, comme `commercial-request`).
- Énumération : une adresse déjà inscrite reçoit la même réponse `202`, sans nouvel e-mail. Limite connue : cette réponse
  est plus rapide (pas d'envoi d'e-mail), ce qui peut se mesurer.
- Preuve (`Comment` de type `Info` sur l'`Email Group Member`, en-tête `konektag-consent-proof/1`) : action, méthode
  `double-opt-in`, liste et Email Group, texte, version et SHA-256 du texte, `requestedAt` et `confirmedAt` (UTC), tenant,
  site, origine, page, campagne, langue, pairs pseudonymisés (HMAC tronqué, pas d'adresse IP en clair), et une signature
  HMAC du contenu, vérifiable par `verifyProofComment` (une modification ultérieure du Comment est détectable). Le membre est créé
  avec `unsubscribed = 1`, la preuve est écrite, puis il est activé : **un membre n'est jamais actif sans preuve**.
  Une réinscription d'un ancien membre exige une nouvelle confirmation et ajoute une nouvelle preuve.
- Désinscription : `unsubscribeToken` (renvoyé par la **première** confirmation seulement ; un nouveau clic répond
  `SUBSCRIBED` avec `unsubscribeToken: null`) est une capacité permanente signée HMAC qui désigne le
  membre (`tenantId`, site, nom du membre, Email Group), sans adresse e-mail. Elle est refusée si la signature, le
  tenant/site ou l'Email Group ne correspondent pas. Le retrait est appliqué d'abord, la trace ensuite (un échec de
  trace n'annule pas le retrait). `POST` seulement : les scanners de liens ne désinscrivent pas.
  Les envois faits depuis Frappe gardent leur lien standard `frappe.email.queue.unsubscribe`.

## Sécurité

- Pas d'autorité implicite : aucun cookie ni session n'est lu par ces opérations ; JSON obligatoire (`415` sinon), ce
  qui impose un preflight CORS à toute page tierce. Le contrôle d'origine et de scope par site est celui du registre KON-107 (`allowedOrigins`, `publicScopes`).
- Isolation : chaque écriture va au seul site résolu ; un jeton signé pour un tenant ne peut pas viser le site d'un autre
  (`404 SITE_NOT_FOUND`).
- Journal sans donnée personnelle : `[public-forms] {"event":"contact.recorded" | "optin.confirmation_sent" |
  "optin.confirmed" | "optin.unsubscribed", tenantId, siteId, emailId (pseudonyme), …}`.

## Configuration

| Variable | Rôle |
|---|---|
| `PUBLIC_FORMS_TOKEN_SECRET` | ≥ 32 caractères ; signe les jetons de désinscription et pseudonymise e-mails et pairs. Sans elle, les formulaires répondent `503 SERVICE_UNAVAILABLE`. **Sa rotation invalide les liens de désinscription déjà émis et rend invérifiables les signatures des preuves passées** (les preuves restent lisibles). |
| `PUBLIC_OPTIN_LISTS` | listes et origines de confirmation par tenant (ci-dessus) ; JSON invalide = opt-in indisponible |
| `RESEND_API_KEY`, `RESEND_FROM` | e-mail de confirmation (expéditeur Konektag) |
| `TURNSTILE_SECRET_KEY` | optionnel |

## Schémas Frappe relevés (2026-11-21, sondes invité en lecture seule)

Sur EUROPE, KONEKTAG_CG, LIBAN, rocherdesages et abmdemo (Frappe/ERPNext 16) : `Lead`, `CRM Lead`, `Issue`,
`Communication`, `Email Group`, `Email Group Member` existent ; app `newsletter` absente ; `frappe.email.queue.unsubscribe`
présent ; pas de Helpdesk (`HD Ticket`). Les DocTypes standards suffisent : **aucun champ ni extension Frappe n'est
nécessaire**, la preuve de consentement est un `Comment` standard. Les droits du compte API de chaque site sur `Lead`,
`Communication`, `Issue`, `Email Group`, `Email Group Member` et `Comment` n'ont pas pu être vérifiés sans identifiants ;
un refus apparaît en `CRM_REJECTED` / `OPTIN_UNAVAILABLE` avec le statut Frappe dans le journal. À vérifier avant mise
en service : création de `Comment` par le compte API (sinon aucune confirmation n'aboutit, sans activer de membre).

## Recette

`tests/unit/public-forms.test.ts` : faux Frappe REST par hôte derrière le vrai client `FrappeSite`. Il vérifie BE → EUROPE,
RDA et ABM Demo isolés, doctypes et champs écrits, déduplication, idempotence et reprise, preuve avant activation,
désinscription idempotente, jetons forgés / altérés / inter-tenant, listes et origines d'un autre tenant, limites, piège,
validation. **Ce sont des simulations** : aucune écriture n'a été faite sur un site Frappe réel.
