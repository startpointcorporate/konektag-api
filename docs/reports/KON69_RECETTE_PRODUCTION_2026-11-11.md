# KON-73 — recette finale du flux ERPNext — 2026-11-11

## Résultat

Le défaut de date est corrigé dans PR #54, à partir de `8e40c2fab853e1c8cfe0e02fd9c92f87491e0dfd`. Le **service TypeScript réel corrigé** a exécuté Quotation → Sales Order → Payment Request sur France, Congo et Liban via les contrôleurs Frappe natifs de leurs vrais sites de production, dans une transaction Bench par site. Aucune date n'est saisie par le harnais. Deux appels du service réutilisent les mêmes SO/PR. Tous les documents temporaires et séries de numérotation sont restaurés par rollback vérifié.

Aucun paiement, facture, Payment Entry, crédit de portefeuille, changement fiscal/Frappe, déploiement ou merge. L'essai s'arrête explicitement avant l'insertion de l'ordre de paiement PostgreSQL, après capture/vérification des arguments et références réellement produits par le service.

## Champ obligatoire et correction

Source examinée sur le bench réel : `erpnext/selling/doctype/sales_order/sales_order.py`, `SalesOrder.validate_delivery_date()` lignes 445–465, appelé par `validate()` à l'insertion et à la soumission. Pour `order_type=Sales` et `skip_delivery_note=0` :

- `Sales Order.delivery_date` est requis si aucune ligne `Sales Order Item.delivery_date` ne fournit une date.
- Si des lignes sont datées, ERPNext calcule l'en-tête au maximum de leurs dates.
- Si l'en-tête est daté, ERPNext le propage aux lignes sans date et refuse une date de ligne antérieure à `transaction_date`.

Le mapper natif `quotation.make_sales_order` conserve le Customer, calcule le document et ses valeurs par défaut, mais ne renseigne pas ici la livraison. L'insertion échouait donc avant la soumission du SO avec « Entrez la Date de Livraison » / « Please enter Delivery Date ».

Le correctif API, immédiatement après le mapper et avant `site.insert('Sales Order', ...)`, conserve toute date d'en-tête ou de ligne déjà fournie. **Uniquement si toutes sont absentes**, il copie la `transaction_date` renvoyée par ERPNext dans `delivery_date`. Il laisse ERPNext propager et valider les lignes. Aucun délai, date issue de l'horloge API, calcul de lead time ou calendrier métier ajouté. Ce défaut technique reprend la date native du document, cohérente avec le repli « aujourd'hui » du formulaire natif de planification et les tests natifs de conversion ; le contrôleur ne choisit pas automatiquement une promesse de livraison. Si le mapper n'a pas de `transaction_date`, l'API refuse avec `SALES_ORDER_DELIVERY_DATE_UNAVAILABLE` plutôt que fabriquer une date.

Six tests de non-régression couvrent date native différente de l'horloge de test, conservation de l'en-tête, conservation des lignes pour agrégation native refus sans date native et absence de repli quand le contrôleur natif ne requiert pas de livraison. Aucun contournement `skip_delivery_note` ni changement de type de commande.

## Recette réelle du code corrigé

| Contrôle | France | Congo | Liban |
|---|---|---|---|
| Site | europe.erp.konektag.eu | congo.erp.konektag.eu | liban.erp.konektag.eu |
| Compte natif de service | api-europe@konektag.eu | api-congo@konektag.eu | api-lebanon@konektag.eu |
| Quotation de test initiale sans date de livraison | vérifié | vérifié | vérifié |
| Soumission Quotation par le service TS | oui | oui | oui |
| Mapper natif puis date renseignée par le service TS | oui | oui | oui |
| SO inséré/soumis, dates de lignes propagées par ERPNext | oui | oui | oui |
| PR native soumise et référencée au SO | oui | oui | oui |
| Même Customer / alias Keycloak de recette | conservés | conservés | conservés |
| TTC Quotation = SO = PR | 12 EUR | 8 567 XAF | 12,21 USD |
| Deuxième appel du même service | même SO/PR | même SO/PR | même SO/PR |
| Metadata SO/PR et montant mineur | vérifiés, 1 200 | vérifiés, 8 567 | vérifiés, 1 221 |
| Rollback documents / source / séries | vérifié | vérifié | vérifié |

Le Congo conserve `grand_total=8 566,74` et `rounded_total=8 567` du devis ; la PR native demande bien 8 567 XAF. Les taux et calculs proviennent exclusivement d'ERPNext. La date d'en-tête SO et chaque date de ligne égalent la `transaction_date` native ; les valeurs exactes figurent dans les preuves.

## Méthode, isolation et limites exactes

`tests/integration/points-k-checkout.bench.live.ts` appelle directement **createPointsKCheckout de la PR**, deux fois. Son adaptateur FrappeSite transporte les opérations par stdio vers `bench --site SITE console` en SSH/kubectl existants. `points-k-checkout.bench.py` exécute les vrais `frappe.client.get/get_list/insert/submit`, le mapper et make_payment_request, sous le compte de service. Aucun serveur HTTP factice, contrôleur simulé, faux Frappe ni résultat ERPNext synthétique.

Les routes sont celles d'une relecture HTTP réelle du routage PostgreSQL et des sites via le harnais existant `points-k-checkout.live.ts`, puis transmises au service testé. Aucun Secret ni mot de passe exporté du cluster. Le sujet Keycloak est celui de la fixture KON-68 injecté à l'entrée du service, pas un login navigateur. Le transport Bench préserve une transaction unique ; il ne prétend pas tester le réseau HTTP du POST public non déployé.

Le seul remplacement côté création d'ordre est une **garde qui lève une exception**, après avoir reçu les vrais arguments du service ; elle ne retourne jamais une fausse réussite. Ainsi aucun ordre api_payment_orders n'est créé dans la base partagée, aucune migration n'est exécutée et les références de metadata sont vérifiées sans paiement. La persistance de cet ordre et l'idempotence PostgreSQL ne sont pas revendiquées. Le rejeu séquentiel SO/PR est prouvé sur le vrai ERPNext ; aucun test de concurrence inter-transactions n'est revendiqué.

Avant tout write, le harnais vérifie les mêmes préconditions sûres que la recette précédente : aucune gateway configurée, webhook/workflow/affectation/Server Script actif ; document réservé sans lien CRM/réservation, Customer alias de test, article non stocké. La fixture est une copie transactionnelle du devis KON-68, sans date de livraison ; seul le service corrigé la définit sur le SO mappé. Les écritures sont limitées aux documents temporaires créés dans cette transaction.

Les gardes de processus interdisent commit, nouvelles connexions réseau, enqueue, sendmail et émission realtime par exception, sans simuler de succès. Aucun déclenchement de ces gardes lors de l'essai final. Le rollback est exécuté en finally, y compris à la fermeture du transport, puis relu : documents créés absents, devis source inchangé, tabSeries identique et comptages avant/après strictement identiques pour Customer, Lead, Quotation, Sales Order, PR, Sales Invoice, Payment Entry, GL Entry, Email Queue, Communication, Notification Log, Version, ToDo, Integration Request. Aucune notification ni écriture commerciale durable.

## Contrôle PSP conservé

La correction précédente séparant préparation ERPNext et disponibilité du paiement reste en place. GET checkout réel retourne 200 avec le devis et `paymentContext=null`, `paymentContextError=PAYMENT_CONTEXT_REGULATORY_PROFILE_NOT_FOUND` ; endpoint de contexte de financement toujours en 422 sur les trois pays. Les profils de l'entité/prestataire restent en Compliance Review et ne sont pas approuvés artificiellement. Aucun client ne doit attendre une approbation individuelle de recharge ; les habilitations globales conditionnent le paiement effectif, qui n'est pas testé ici.

## Preuves et validation

[Preuves finales du correctif de livraison](KON73_LIVRAISON_PREUVES_2026-11-11.json) : exécution TS, dates natives et propagées, références anonymisées, TTC, double appel, frontière PostgreSQL et reçus de rollback. Les preuves antérieures restent historiques : [correction PSP](KON69_RECETTE_CORRECTION_PREUVES_2026-11-11.json), [première recette](KON69_RECETTE_PRODUCTION_PREUVES_2026-11-11.json).

Typecheck réussi. Tests checkout : 11 réussis dont six nouveaux cas de date. Suite complète : 178 fichiers, 2 837 tests réussis et cinq échecs attendus préexistants, 2 842 cas ; inventaire/couverture REST régénérés. Le générateur compte les expected-fail dans son compteur passedTests ; ils ne constituent pas des défauts corrigés. Ces tests unitaires sont distincts des preuves réelles ci-dessus.

Reproduction : compiler les deux harnais TS avec esbuild (platform=node, format=esm, packages=external). Exécuter le harnais HTTP dans /tmp du pod API existant et conserver son résultat privé ; lancer localement le harnais Bench avec `KON73_ALLOW_BENCH_ROLLBACK=YES`, `KON73_ROUTING_RESULT_PATH=/tmp/RESULTAT_HTTP.json`, `KON73_RESULT_PATH=/tmp/RESULTAT_BENCH.json` et une DATABASE_URL locale inutilisée à l'import (aucune connexion). Il lit le script Python versionné, réutilise SSH/kubectl et cible toujours un site explicite. Les gardes/contrôles préalables restent obligatoires pour tout rejeu.

Le bilan précédent a déjà été publié dans Paperclip depuis ChatGPT selon l'utilisateur ; aucune résolution de reconnexion requise pour cette livraison. Nouveau SHA et CI finale dans la PR #54. Recette de préparation ERPNext terminée dans ce périmètre, sans fusion ni mise en production.
