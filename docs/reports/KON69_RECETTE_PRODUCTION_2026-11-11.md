# KON-73 — diagnostic corrigé et recette réelle — 2026-11-11

## Conclusion

Le contrôle `link_payment` était **appliqué trop tôt dans KON-69**. Il ne représente pas une approbation de chaque client/recharge. La PR #54 sépare maintenant préparation ERPNext et disponibilité du paiement. Aucun profil n'a été approuvé, aucun contrôle PSP supprimé, aucun checkout reconstruit.

Le GET corrigé rend le devis sur les trois vrais ERPNext malgré `Compliance Review`. La chaîne native complète Quotation → Sales Order → Payment Request a été réellement soumise sous Bench sur FR/CG/LB, dans une transaction annulée, **avec date de livraison renseignée explicitement dans les documents temporaires**. Les trois montants TTC et le Customer sont conservés. Aucun document durable, paiement, facture ou écriture comptable créé.

Le flux API complet n'est pas déclaré validé : le mapper sans date de livraison échoue sur les trois sites. Cet écart distinct est documenté sans modification de calendrier métier, conformément au périmètre limité au contrôle réglementaire. Rejeux/concurrence API et metadata PostgreSQL restent à recetter en contexte isolé.

## Contrats et cause exacte

Contrats relus : Paperclip KON-69 (83a9cadf-0e14-436f-a6b2-61be3eb19796), KON-73 et son commentaire prioritaire du 11 novembre à 19:04:20 UTC, PR #54 au SHA de départ 3978f051dabe9a99e58de12870726b4eb9579635, documentation flux 1 et code du financement existant.

Au SHA initial, `points-k-checkout-service.ts:34` appelait `resolveForRoute(route, 'link_payment')` dans `owned()`. GET et POST passaient tous deux par ce contrôle avant `frappe.client.submit` et avant le mapper/Sales Order.

Le résolveur existant `payment-context-resolver.ts:179-198` sélectionne l'entité Konektag approuvée du pays, puis les profils `status=Approved`, `runtime_operation=link_payment`, courants et rattachés à cette entité. Les profils réels LINK-FR-STRIPE, LINK-CG-PAWAPAY, LINK-LB-STRIPE sont en `Compliance Review` : aucun profil éligible, donc `PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND`.

Ce contrôle dépend de `profile.legal_entity`, du corridor et du prestataire, **pas de Customer.alias ni d'une approbation individuelle de la recharge**. L'ownership du client est un contrôle séparé.

Le nom `link_payment` est partagé par le mécanisme de financement existant : `prepareSelectedFunding` dans `api-payment-checkout-service.ts:893-919` exige déjà un profil `authorized_operation=link_payment`, `status=APPROVED`, valide, une entité et un acteur approuvés. `prepareFundingOrder:1065-1069` traite les wallet_recharge comme merchantless, bénéficiaire NETWORK ; `:1104-1105` exige leur financement externe avec contexte sélectionné. Aucun contrat ou code n'établit ici un autre runtime_operation propre aux Points K : ne pas inventer un nouveau profil. L'anomalie démontrée est le **placement du prérequis PSP dans l'ownership/préparation ERPNext**, pas la nécessité de supprimer l'habilitation de l'entité/prestataire pour le paiement effectif.

## Trois opérations distinctes

| Opération | Contrôles réellement pertinents dans le code | Profil PSP approuvé |
|---|---|---|
| Création/soumission du Sales Order | Ownership Customer/Lead/Quotation, permissions natives, validations ERPNext dont date de livraison | Pas de prérequis natif démontré ; succès réel sous Compliance Review |
| Création/soumission d'une Payment Request sans gateway | Sales Order soumis, Customer, devise/montant, permissions natives | Pas de prérequis natif démontré ; succès réel sous Compliance Review |
| Soumission PR avec gateway / initiation Stripe ou pawaPay | Peut appeler un contrôleur PSP ; financement API exige sélection signée, habilitations entité/corridor/acteur/prestataire | Contrôles existants conservés ; aucun paiement essayé |

ERPNext `PaymentRequest.before_submit` appelle request_phone_payment pour Phone, sinon set_payment_request_url, puis éventuellement email. `mute_email=1` n'empêche pas une gateway de démarrer une interaction PSP. La PR ajoute donc une vérification explicite du Payment Gateway Account par défaut de la société avant la création/soumission native : si présent, erreur `PAYMENT_REQUEST_EXTERNAL_GATEWAY_CONFIGURED`, sans initier de paiement. Les trois sites réels n'ont aucun Payment Gateway Account. Aucune valeur artificielle ni réglage Frappe n'est injecté pour contourner un contrôleur.

## Correction minimale dans PR #54

- `owned()` reste réservé à l'ownership, au devis et aux modes natifs ; le POST prépare les documents et l'ordre de checkout existant sans résoudre un PSP.
- Le GET résout séparément la disponibilité du financement. En cas d'erreur de contexte, il retourne HTTP 200 avec le devis natif, `paymentContext=null` et `paymentContextError` explicite. Aucun provider ni token de sélection n'est fabriqué. Les modes ERPNext décrivent des moyens natifs ; leur présence ne vaut pas habilitation PSP.
- Un contexte disponible garde sa validation de devise et les sélections signées existantes. L'endpoint `/api/pay/payment-context` et le financement/PSP ne changent pas. L'erreur 422 ajoutée précédemment au handler reste utilisable pour les erreurs de contexte propagées ; le cas sous revue est désormais un état de disponibilité dans le GET du devis.
- Le contrôle gateway empêche de déplacer involontairement une initiation PSP dans l'étape native ERPNext. Aucun nouvel endpoint, mécanisme de paiement, taux ou logique fiscale.

Une recharge de 10 EUR ne doit pas créer une tâche d'approbation individuelle : aucune n'est introduite. L'habilitation globale entité/prestataire reste une condition de disponibilité du paiement et ne doit pas être confondue avec l'achat du client.

## Recette réelle FR / CG / LB

| Contrôle exécuté | France / EUR | Congo / XAF | Liban / USD |
|---|---|---|---|
| Site réel | europe.erp.konektag.eu | congo.erp.konektag.eu | liban.erp.konektag.eu |
| Compte de service existant | api-europe@konektag.eu | api-congo@konektag.eu | api-lebanon@konektag.eu |
| GET checkout corrigé | 200 + devis | 200 + devis | 200 + devis |
| Contexte PSP existant | 422, profil sous revue | 422, profil sous revue | 422, profil sous revue |
| Sujet Keycloak étranger | rejeté | rejeté | rejeté |
| Quotation temporaire soumise | oui | oui | oui |
| SO sans date de livraison | refus natif, rollback | refus natif, rollback | refus natif, rollback |
| SO temporaire avec date explicite, soumis | oui | oui | oui |
| Payment Request native soumise depuis SO | oui | oui | oui |
| Customer conservé / aucun Customer supplémentaire | oui | oui | oui |
| TTC Quotation = SO = PR | 12 | 8 567 | 12,21 |
| Rejeu natif make_payment_request | rejet, aucun doublon | rejet, aucun doublon | rejet, aucun doublon |
| Rollback documents / séries / source | vérifié | vérifié | vérifié |
| Init PSP / facture / Payment Entry / GL | aucune | aucune | aucune |

Le Congo conserve le TTC natif arrondi : 7 205 HT + 1 361,74 taxes = 8 566,74 grand_total → 8 567 rounded_total. Aucun calcul fiscal alternatif. Le devis d'origine KON-68 reste inchangé et les Sales Orders historiques restent brouillons.

## Garanties et limites de l'essai Bench

Le script `tests/integration/points-k-native-rollback.py` utilise les vrais modules, base et contrôleurs du bench de production via `bench --site SITE console`, avec l'utilisateur de service correspondant. Copie transactionnelle du seul devis réservé KON-68, alias de recette vérifié ; aucun client réel utilisé. Pas de faux Frappe ni de réponses synthétiques.

Avant write : aucun Payment Gateway Account, Webhook activé, Workflow actif, Assignment Rule ou Server Script activé ; pas de crm_deal/k360_reservation sur le devis, article non stocké. Hooks runtime relus : CRM ne crée pas de Customer si présent, Konektag sales retourne sans réservation, Link Pay protège seulement ses demandes marquées.

Les commits, nouvelles connexions réseau, enqueues, sendmail et émissions Redis sont **interdits par des gardes de processus qui lèvent une exception**, jamais simulés comme réussis. Les contrôleurs métier, SQL et calculs restent réels ; les notifications after_commit natives ne sont jamais validées. Aucune garde déclenchée dans les essais réussis. Rollback dans finally, puis relecture et comparaison : tous les documents créés absents, source intacte, tabSeries identique et tous les comptages identiques (Customer, Lead, Quotation, SO, PR, facture, Payment Entry, GL, Email Queue, Communication, Notification Log, Version, ToDo, Integration Request).

Cet essai prouve les opérations natives dans **une transaction Bench**. Il n'exécute pas le POST API en HTTP, dont les transactions séparées ne seraient pas annulées par ce rollback. La date de livraison ajoutée à la fixture n'est pas présente dans le code API ; le succès natif ne certifie donc pas le flux API complet. Le rejeu natif démontre un rejet sans nouvelle PR, pas l'idempotence/concurrence de l'ensemble API/PostgreSQL. Aucun login navigateur ou endpoint public déployé testé.

## Preuves, tests et reprise

[Preuves de correction et transactions natives](KON69_RECETTE_CORRECTION_PREUVES_2026-11-11.json) : résultats HTTP réels, profil sous revue, préconditions natives, erreurs sans date, réussites avec date, hashes des références et comptages avant/après. Les [preuves de la première recette](KON69_RECETTE_PRODUCTION_PREUVES_2026-11-11.json) restent historiques. Aucun Secret publié.

Harnais HTTP `tests/integration/points-k-checkout.live.ts` compilé avec esbuild, exécuté sous /tmp/kon73-acceptance dans le pod API existant, avec ses dépendances/variables ; aucun fichier actif, image ou Deployment modifié. Tests Bench opt-in explicite `exec(code, {'KON73_ALLOW_NATIVE_ROLLBACK': True, 'KON73_NATIVE_DELIVERY_DATE': True})` depuis la console du site ciblé ; sans second flag, le refus de date est reproduit. Toujours vérifier les préconditions avant rejeu.

Typecheck réussi ; 55 tests ciblés (checkout, erreurs, contexte, financement existant) réussis. Suite locale complète et rapports REST régénérés : 178 fichiers, 2 831 tests réussis et cinq échecs attendus préexistants, 2 836 cas. Les tests unitaires comportent des doublures et sont distincts des deux recettes réelles. Le générateur compte les cinq expected-fail parmi ses passedTests ; ils ne sont pas des défauts corrigés. CI du SHA final publiée dans KON-73.

Suite restante : traiter séparément le prérequis de date de livraison selon la règle métier attendue ; valider rejeux/concurrence et metadata dans PostgreSQL isolé ; terminer les habilitations globales avant tout financement PSP. Aucune approbation individuelle de recharge requise par le correctif. Aucun merge, déploiement, migration, PSP ni donnée métier durable pendant cette mission.
