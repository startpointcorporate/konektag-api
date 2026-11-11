# KON-68 — qualification des cinq échecs préexistants — 2026-11-11

## Conclusion

Les cinq défauts sont reproduits à l'identique sur la base de la PR et sur le head contenant KON-68 et sa recette ERPNext. Ils ne constituent pas une régression introduite par KON-68.

Ils ne sont ni corrigés ni rendus acceptables par ce constat. Deux portent sur l'authentification ou l'autorisation ; les autres sur l'identité des consentements et des agrégats monétaires. Ils restent des défauts ouverts hors périmètre de cette PR.

**Formulation exacte de la suite : 2 820 tests réussis + 5 échecs attendus préexistants (`it.fails`). La suite n'est pas entièrement verte fonctionnellement.** Le succès de la CI indique notamment que les échecs déclarés attendus sont tolérés, pas que ces cinq assertions ont réussi.

## Périmètre comparé

- Base de PR : `b3de385da6968f91673918ac9b4c7558f2a45fa7`.
- Head vérifié après recette réelle : `f1b35e1edf609020342bc6a3a606e08b659ecd4e`.
- Les quatre fichiers contenant les cinq tests existent déjà dans la base.
- Dernière introduction/modification commune identifiée : commit `ebbd62c`, 3 novembre 2026, antérieur à KON-68.
- Les quatre fichiers de tests, leur harness et les sept fichiers métier concernés sont identiques octet pour octet entre ces deux références.
- Aucune modification de code métier ni des marqueurs `it.fails` sur la branche pendant cette vérification.

## Reproduction contrôlée

Deux worktrees détachés, un sur chaque référence, ont été utilisés. Aucun appel de production : bases et adaptateurs externes sont simulés par ces tests fonctionnels existants.

Dans ces seules copies temporaires, les cinq occurrences `it.fails(...)` ont été remplacées par `it(...)` pour observer leur échec sans le masquage de résultat attendu. Les fichiers versionnés de la branche ont conservé leurs marqueurs.

| Exécution ciblée des quatre fichiers | Réussis | Échecs réels | Sortie |
|---|---:|---:|---|
| Base avec les marqueurs attendus | 85 comptés comme réussis par le reporter JSON | 0 non attendu | 0 |
| Base sans les cinq marqueurs, copie temporaire | 80 | 5 | 1 |
| Head sans les cinq marqueurs, copie temporaire | 80 | 5 | 1 |

Les cinq noms complets et premiers messages d'assertion sont identiques entre base et head. La suite complète sur la branche conserve 176 fichiers, 2 820 réussites et 5 échecs attendus.

## Les cinq défauts

| # | Test / route | Attendu | Observé sur base et head | Composant responsable | Correction nécessaire |
|---|---|---|---|---|---|
| 1 | `communication.test.ts:17` — GET `/api/communication/preferences` | Lire les consentements avec l'UUID interne de l'utilisateur | Paramètre SQL `kc-owner` (identifiant Keycloak) au lieu de l'UUID interne | `src/api/routes/communication/preferences.ts`, choix `user.keycloak_id || user.id` | Employer l'identité interne canonique pour le stockage des consentements ; résoudre explicitement le sujet externe si nécessaire |
| 2 | `communication.test.ts:21` — PUT `/api/communication/preferences` | Résoudre/modifier les consentements avec l'UUID interne | Même confusion d'identité dans la recherche de l'utilisateur avant modification | Même route, chemin PUT | Même correction d'identité sur le chemin d'écriture, avec tests GET et PUT |
| 3 | `agents.test.ts:36` — GET `/api/earn/agent/dashboard` | Agrégats numériques : 12,5 de commissions, 100 de volume, 12,5 payés | Les décimaux PostgreSQL simulés sous forme de chaînes ne sont pas normalisés avant `+=` | `src/application/services/agent-service.ts`, `getAgentDashboard` | Normaliser les montants avant agrégation et préserver un traitement monétaire explicite |
| 4 | `country-and-providers.test.ts:44` — POST `/api/internal/kyc-publish-status` | HTTP 401 et aucun événement si le jeton interne n'est pas configuré | HTTP 204 ; l'absence de jeton reçu égale l'absence de configuration (`undefined === undefined`) | `src/api/routes/internal/kyc-publish-status.ts` | Refuser explicitement toute configuration ou présentation de jeton absente/vide avant comparaison et publication |
| 5 | `merchant-messages.test.ts:13` — PUT `/api/merchant/messages` | HTTP 403 et aucune mutation pour le message d'un autre marchand | HTTP 200 ; mutation par seul identifiant de message | Route `merchant/messages.ts`, puis `contactService.markAsRead` dans `src/application/services/contact-service.ts` | Transmettre l'utilisateur authentifié et borner l'UPDATE au message appartenant à son marchand |

Ces observations sont celles des tests et du code des références comparées ; elles ne constituent pas une tentative d'exploitation de ces routes en production.

## Noms exacts des tests

1. `looks up internal user consent by the canonical user id, not a different Keycloak id (known identity defect)`.
2. `resolves the canonical internal user before changing consent (known identity defect)`.
3. `returns numeric monetary aggregates for PostgreSQL decimal strings (known arithmetic defect)`.
4. `fails closed when no internal token is configured (known authentication defect)`.
5. `rejects a foreign merchant message instead of mutating it by id alone (known ownership defect)`.

## Pourquoi ils ne sont pas imputables à KON-68

Les routes, services et tests ci-dessus sont inchangés par la PR #52. Le harness `tests/rest/functional/database.ts` importe et appelle directement les handlers avec des identités de fixture ; il ne passe pas par le middleware modifié pour protéger `/api/points-k/`.

La seule modification de ce middleware par KON-68 est l'ajout du préfixe protégé `/api/points-k/`. Elle ne change pas les cinq handlers et n'intervient pas dans l'exécution de leurs tests.

KON-68 utilise volontairement le sujet Keycloak comme alias externe ERPNext. Les consentements, eux, doivent utiliser l'UUID interne de la base Konektag : les deux contextes de stockage ne sont pas interchangeables. La présence de l'expression « Keycloak ID » dans ces deux fonctionnalités ne démontre pas de causalité.

Les cas KYC, tableau de bord agent et messages marchands ne sont pas dans le flux Customer → Lead → Quotation → Sales Order. Leur comportement fautif est déjà présent dans la base et reste identique après KON-68.

## Contrôle des fichiers inchangés

- `tests/rest/functional/communication.test.ts`
- `tests/rest/functional/agents.test.ts`
- `tests/rest/functional/country-and-providers.test.ts`
- `tests/rest/functional/merchant-messages.test.ts`
- `tests/rest/functional/database.ts`
- `src/api/routes/communication/preferences.ts`
- `src/application/services/communication-consent-service.ts`
- `src/api/routes/earn/agent/dashboard.ts`
- `src/application/services/agent-service.ts`
- `src/api/routes/internal/kyc-publish-status.ts`
- `src/api/routes/merchant/messages.ts`
- `src/application/services/contact-service.ts`

Chaque contenu lu par `git show BASE:CHEMIN` a été comparé directement à `git show HEAD:CHEMIN` : aucune différence.

## Rejouer sans toucher aux tests de la branche

Créer deux worktrees détachés aux SHA ci-dessus, installer les dépendances du lockfile, puis exécuter les quatre fichiers :

```bash
node_modules/.bin/vitest run \
  tests/rest/functional/communication.test.ts \
  tests/rest/functional/agents.test.ts \
  tests/rest/functional/country-and-providers.test.ts \
  tests/rest/functional/merchant-messages.test.ts \
  --reporter=json --outputFile=/tmp/kon68-result.json
```

Dans les worktrees temporaires seulement, remplacer ensuite les cinq `it.fails(` par `it(` et rejouer la même commande. Ne pas committer cette modification : la sortie 1 et les cinq échecs sont les résultats attendus de la démonstration.

## Portée de la validation

La [recette ERPNext de KON-68/KON-69](KON68_RECETTE_PRODUCTION_2026-11-11.md) reste une preuve métier distincte : trois vrais sites, identifiants de service existants, prix/taxes/budgets natifs et conversion sans doublon de Customer. Les défauts ci-dessus n'y ont pas été exercés ni corrigés.

La validation de KON-68 ne doit donc pas être libellée « toute la suite est verte » ou « l'API ne présente aucun défaut ». Elle peut distinguer la recette métier concluante, l'absence de régression de ces cinq cas et la dette fonctionnelle/sécurité toujours ouverte.
