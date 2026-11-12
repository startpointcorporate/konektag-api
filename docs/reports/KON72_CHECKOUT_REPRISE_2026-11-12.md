# KON-72 — persistance et reprise du checkout Points K

Base : `2c698568` (#57). Livraison API requise avant le Web de reprise.

## Causes confirmées

- `getPublicOrder` pouvait expirer une opération `processing`/`awaiting_mobile_money` uniquement parce que le lien avait vieilli. Une lecture pouvait donc fermer une opération PSP encore inconnue.
- Stripe : la route créait une autre intention avec une clé aléatoire lorsque la tentative locale avait expiré, même si la référence Stripe restait enregistrée. Une réponse perdue avant l’attachement n’avait pas de clé stable pour sa reprise.
- pawaPay : après envoi incertain, `depositRequested=true` était conservé mais l’expiration locale pouvait encore libérer cette tentative. Les tests PostgreSQL reproduisent aussi le cas d’une ancienne tentative active avec TTL déjà écoulé.

## Correction

- `api-payment-checkout-service.ts` : un checkout Points K engagé n’expire pas sur le seul âge du lien. La réservation Stripe est persistée atomiquement dans la commande existante, avant appel PSP, avec date d’initiation dans les métadonnées existantes ; aucun schéma ou service ajouté.
- `stripe/create-intent.ts` : retrouve toujours l’intention Points K enregistrée. Avant toute référence enregistrée, utilise une clé d’idempotence stable propre à la commande. Après 30 minutes d’initiation non référencée, refuse une nouvelle émission et exige la réconciliation, en conservant la commande en cours. Expose le statut PSP pour reprendre son interaction ; ce statut ne règle jamais la commande.
- `payment-provider-attempt-service.ts` : l’envoi pawaPay marqué engagé supprime l’expiration locale ; une ancienne tentative active `depositRequested=true` reste retrouvable et réutilise le même depositId. Le balayage temporel conserve ces tentatives et les tentatives Stripe des commandes Points K.
- Route GET checkout : `Cache-Control: no-store` pour les observations de statut.
- Transitions terminales de la commande protégées par le mécanisme existant, avec assertions supplémentaires ; aucune résurrection automatique des commandes historiquement terminales.

## Vérification

- Reproduction unitaire initiale : 4 échecs, sur expiration en cours et reprise Stripe.
- Reproduction PostgreSQL supplémentaire : l’ancienne tentative ambiguë avec TTL écoulé échoue avant correction et passe après.
- Suite API complète : 183 fichiers, 2955 réussites, 5 échecs attendus déclarés (2960 cas).
- PostgreSQL 16 jetable : 20 tests réussis, migrations jusqu’à 234 ; PSP/ERPNext/valorisation simulés. Métadonnées d’initiation Stripe persistées et maintien après vieillissement du lien vérifiés ; timeout pawaPay, TTL ancien, références identiques et callbacks locaux concurrents couverts.
- Typecheck et build réussis. Couverture REST régénérée après relecture des assertions modifiées, sans recul par rapport à `origin/main`.

Commandes : `npm run typecheck`, `npm run build`, `npm run test:rest:coverage -- --check --baseline-ref origin/main`. Tests PostgreSQL : commande CI existante avec une base `konektag_test` jetable.

## Limites et livraison

Aucune migration supplémentaire, configuration PSP, modification de profil réglementaire, écriture sur base partagée, opération financière réelle ou callback partagé. Aucune fusion ni déploiement.

Une initiation non référencée de plus de 30 minutes reste bloquée en attente de rapprochement humain/PSP : la sécurité prime sur l’émission d’une nouvelle opération. Les commandes déjà terminales avant ce correctif ne sont pas réouvertes automatiquement. Les réponses Stripe et pawaPay authentiques restent à recetter dans un environnement financièrement isolé autorisé.

Référence fonctionnelle : KON-72 ; préparation native GitHub #51, sans clôture automatique. Le défaut du formulaire opérateur, les profils/configurations PSP et les autres blocages ne sont pas traités.
