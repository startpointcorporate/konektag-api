# Référentiels gouvernés de Recharger

La migration 234 conserve les lignes de fiscalité créées par la migration 183,
mais les classe `DRAFT` avec la provenance
`LEGACY-MIGRATION-183-UNVERIFIED`. Elles ne sont donc pas utilisables comme
paramètres réglementaires approuvés.

## Paramètres et provenance

- Une règle fiscale identifie pays, devise et type de taxe. Elle définit une
  assiette, un calcul en taux ou montant fixe, la précision de la devise et
  l'arrondi `HALF_UP` par ligne en unité mineure.
- Une règle de plafond identifie pays, devise, rail, provider et niveau KYC.
  Elle définit minimum, maximum par transaction, plafond journalier et plafond
  mensuel en unité mineure.
- Toute règle `APPROVED` exige `source_reference`, `approval_reference`,
  `approved_by`, `approved_at`, une devise et sa précision. Les lignes
  historiques hors FR restent conservées avec devise/précision nulles plutôt
  que de leur inventer des paramètres ; cette incomplétude interdit leur
  approbation. Les périodes approuvées ne peuvent pas se chevaucher pour une
  même identité.
- Une application à un ordre conserve un snapshot JSON. Dès qu'une règle a été
  appliquée, sa mise à jour ou sa suppression est refusée ; le snapshot est lui
  aussi immuable.
- Les fonctions de résolution échouent explicitement si aucune règle approuvée
  et active ne correspond. Un taux nul doit donc être une ligne approuvée à
  `0`, jamais l'effet implicite d'une absence de configuration.

## Paramètres encore bloquants

Aucune valeur réelle nouvelle n'est livrée pour FR, CG ou LB. Avant activation,
le métier doit confirmer et documenter les taxes, assiettes, dates d'effet,
plafonds, niveaux KYC, rails/providers, précision/arrondi et approbateurs. Les
valeurs de recette doivent porter une provenance `TEST-FICTIF` et rester dans
une base de test ; elles ne figurent pas dans la migration.

Le checkout Recharger filtre désormais explicitement la devise, le statut
`APPROVED`, l'activation et la période. Il refuse l'opération si aucune règle ne
correspond ; une ligne `DRAFT`, révoquée ou expirée ne produit donc jamais un
0 % implicite. Les assiettes autres que `RECHARGE_AMOUNT` restent refusées tant
que le calcul ordonné taxe/frais correspondant n'est pas implémenté.
