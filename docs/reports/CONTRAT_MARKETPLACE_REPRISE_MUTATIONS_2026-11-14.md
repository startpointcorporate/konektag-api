# Contrat commun — reprise navigateur et mutations Marketplace — 2026-11-14

Statut : VALIDÉ par le coordinateur le 14 novembre 2026 après les trois audits et la revue des dépendances natives. Implémentation par dépôt autorisée ; fusion et production restent autorisées dans la session après contrôles et recette synthétique.
Préfixe P=`/api/public/marketplace/merchants/{slug}/restaurant`. Backend autorité : Frappe/Lumen natif du POS résolu serveur. Aucun nouveau modèle métier ni mécanisme d'authentification utilisateur.

## Preuve du créateur
1. Avant chaque nouvelle création, le navigateur génère managementKey aléatoire256bits et persiste une tentative `{type,idempotencyKey,managementKey,createdAt}` sans contacts ni panier. La preuve existe avant la requête et permet de retrouver un résultat dont la réponse a été perdue. Exception mémoire pleine déjà décidée : avertissement explicite et preuve en mémoire, création non bloquée, aucune éviction silencieuse.
2. Les POST création existants acceptent managementKey facultatif. L'API transmet uniquement ownerHash=SHA256(purpose/type/slug/site/POS/managementKey), stocké dans un champ privé immuable À LA CRÉATION, dans la même insertion/transaction native. Pour réservation, utiliser le hook before_insert avant commit natif.
3. Rejeu : hash identique vérifié natif =>preuve créateur récupérable ; hash différent ou absent sur un ancien enregistrement ne permet ni rattachement tardif ni émission de preuve. Les anciens clients sans managementKey restent compatibles et en lecture seule. Un simple succès ref/status ne suffit pas pour émettre le jeton : le natif doit confirmer explicitement le hash créateur enregistré ; aucune revendication tardive si ownerHash natif NULL.
4. Réponse création/rejeu ajoute managementToken AES-GCM90jours, purpose marketplace-browser-management-v1, type/slug/site/POS/reference/ownerHash/expiration. Jeton réservé au corps JSON et stockage navigateur, jamais URL de partage, lookup ou journal.
5. Reprise : accepter le déchiffrement d'une preuve ancienne expirée pour vérifier le hash NATIF et l'état actif ; renouveler90jours seulement si actif ET preuve expirée ou proche échéance (<=7jours). Si elle reste assez valide, retourner le managementToken identique, sans nouveau nonce/expiry pour éviter les boucles storageevents entre onglets. Mutation : managementToken frais obligatoire. Aucun token sélection/suivi/partage ne peut être converti en droit de gestion.
6. Après succès, remplacer la tentative par `{reference,managementToken,type,createdAt}`. Maximum10réservations et10commandes par restaurant. Pas d'éviction active silencieuse ; une mémoire pleine n'interdit pas la création : avertissement, preuve conservée en mémoire et lien lecture seule copiable, oubli volontaire possible.

## Créations existantes étendues
- POST P/reservation-requests : corps existant + managementKey ; réponse actuelle + managementToken quand créateur vérifié, snapshot minimal et version. Le rejeu renvoie le statut natif courant, pas Requested en dur.
- POST P/orders : corps existant + managementKey ; réponse actuelle/trackingToken + managementToken, version et canEdit. Mode et lien réservation restent immuables après création.
- Ne pas changer l'empreinte commerciale historique avec le jeton éphémère ; vérifier ownership séparément. Un rejeu de création après édition restitue la commande courante et n'applique jamais à nouveau le panier initial.

## Restauration en une lecture
POST P/browser-activities, `{activities:[{type,managementToken}|{type,idempotencyKey,managementKey}]}` maximum20, bornes10+10. Les deux variantes sont strictes ; la seconde résout une tentative sans référence par clé native et ownerHash.
Réponse par entrée, index stable : active/terminal/not_found/pending, référence/type/createdAt/version et snapshot minimal. Erreurs transitoires503/429 conservent preuves ; preuve invalide/révoquée ou ressource absente se distingue d'une création encore en vol pour ne pas perdre le secret prématurément.
- Réservation : status/date/time/partySize, canCancel et canAssociate. Requested ne s'associe pas ; Confirmed future réémet reservationToken15min directement, sans nouvelle recherche. Terminale uniquement si Cancelled/No show ou si seated_order natif est Closed/Cancelled/Merged ; sinon Requested/Confirmed/Seated restent actives même après l’heure prévue, sans horizon inventé. Résumé terminal puis purge locale.
- Commande : DTO de suivi courant, version et canEdit ; trackingToken24h renouvelé. Completed/Cancelled=>résumé terminal puis purge ; native Closed seule ne purge pas si cuisine active.
- Aucun contact dans la collection durable. Les valeurs privées nécessaires à l'édition peuvent être retournées uniquement après preuve propriétaire valide, pour affichage en mémoire du formulaire existant, jamais ajoutées aux DTO lookup/suivi publics.
- Si tentative non retrouvée peut encore être en vol, conserver son secret et permettre réconciliation ; ne pas inventer un succès ni auto-réémettre la création avec des contacts absents.

## Annulation réservation
PATCH P/reservation-requests : `{action:"cancel",managementToken,expectedVersion}`, Idempotency-Key requis.
Après vérification preuve/hash/POS, verrouiller la réservation, comparer version et état COURANTS : annulation seulement Requested avant confirmation. Confirmed/Seated/Cancelled/No show ou changement concurrent=>409 et état frais. Aucun refus supplémentaire fondé sur une heure passée pour Requested. Ne pas supprimer de document ni annuler implicitement une commande.
Rejeu exact de la dernière annulation :200 sans seconde transition. Garder key/fingerprint/baseVersion de la dernière mutation ; même clé et autre contenu=>422.

## Édition commande
PATCH P/orders : `{managementToken,expectedVersion,currency,lines,customer?,note?}`, Idempotency-Key requis. Réutiliser validation/tarification existantes ; customer facultatif reprend les champs existants nom/téléphone/email, aucune persistance navigateur de contacts.
Mode/lien réservation/key de création immuables. canEdit autoritatif = natif Open ET acceptance Pending ET AUCUN ticket cuisine (même New/Cancelled) ET aucune facture ni preuve de paiement liée. Aucune modification quand traitement ou validation a commencé.
Verrouillage commun avant vérification ET avant création native de ticket/facture/paiement/acceptation ; revalidation sous verrou si une opération native a lu une ancienne version. Aucun contrôle API seul ou lecture MVCC périmée.
Version opaque : modified natif à6microsecondes ou hash canonique, comparée exactement serveur ; jamais conversion Date JavaScript. Acceptation marchand reçoit aussi expectedVersion pour refuser une validation d'un panier modifié depuis son affichage.
Rejeu exact de la dernière édition :200 sans réappliquer. Même key/autre contenu=>422 ; ancien key après nouvelle édition=>409 version sans réapplication. Stockage lastEditKey/fingerprint/baseVersion sur le document, pas nouvelle table. Ligne/prix refusé=>409 avec devis frais, sans mutation partielle.

## Adapter et déploiement proposés
Étendre booking.submit et marketplace_orders.checkout avec owner_hash vérifié atomiquement. Service exacts proposés : browser_reconcile (POST,20preuves), browser_cancel_reservation (POST), browser_update_order (POST), tous scope slug/POS et allowlist existante ; noms confirmés par360.
Ajouter champs propriétaires et dernière mutation aux deux DocTypes, hooks et verrous, plus marqueur privé processing_started_at sur commande pour fermer la fenêtre facture avant liaison native.
Stratégie native confirmée par360 (seulement commandes munies du hash créateur ; autres flux inchangés) :
- Overrides whitelisted EXACTS save_order/send_to_kitchen/print_bill/submit_sale. Verrou commande avant lecture et effets ; comparaison version prélecture/courant verrouillé pour refuser une lecture MVCC obsolète.
- Native save_order sur Pending : panier/contact modifié sans expectedVersion=>refus ; no-op conforme au panier courant reste autorisé. Édition client passe par RPC propriétaire avec version.
- Cuisine : delta envoyé comparé au dérivé CURRENT non-envoyé sous verrou, mismatch=>refus avant ticket. Ne pas se contenter d'un hook ticket après lecture d'un ancien panier.
- Vente : résoudre rotation de session avant verrou (commits natifs), comparer _cart_payload canonique au payload courant, poser processing_started_at avant invocation facture. Erreur transactionnelle=>rollback du marqueur ; commit natif éventuel conserve ce début de traitement.
- Impression de note : verrou avant lecture et marqueur/flag bill. canEdit vérifie aussi invoices, bill_printed_at, closed_at et processing_started_at ; pas de paid_total natif inventé.
- Confirmation réservation : verrou + comparaison _original_modified natif courant ; accept_order : expectedVersion requis côté UI pour les commandes gérées. Sans ancienne version fiable, refuser le changement Pending plutôt qu'écraser un panier client.
DemoGuard : autoriser seulement ces RPC exacts au service lié au POS, aucune ouverture Guest ni module entier. Livrer backend/migration/guard/permissions avant API puis UI ; readiness réelle HTTPS création/reprise/mutation, y compris refus horsPOS/Guest.
Erreurs :400entrée invalide ;404preuve/resource inconnue ou horsscope sans PII ;410preuve management expirée en mutation=>réconcilier ;409VERSION_CONFLICT/RESERVATION_NOT_CANCELLABLE/ORDER_NOT_EDITABLE ;422IDEMPOTENCY_KEY_REUSED ;429quota ;503panne. Toute réponse no-store/no-referrer/noindex.

## Validation acquise
Compatibilité Web des collections et preuves confirmée ; stratégie/RPC natifs confirmés360. Validation finale du coordinateur acquise ; développement autorisé. Tests : perte réponse puis reprise sans contacts, retour après TTL90j sur actif, lookup incapable de mutation, reprise Requested puis Confirmed et sélection directe, cancelRequested face confirmation, édition face accept/cuisine/paiement, version périmée et deux onglets, reçus répétés, purge terminale et conservation sur503/429, mémoire pleine non bloquante. Autorisations session merge/prod et recette réelle synthétique persistent après checks ; aucun message réel.
