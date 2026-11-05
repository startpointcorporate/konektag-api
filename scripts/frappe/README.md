# Frappe CRM — prérequis des formulaires publics Konektag

Deux scripts **Bench Python** versionnés dans `konektag-api`. Aucun appel à la production, aucune demande client ou notification envoyée pendant leur exécution.

## Utilisation

À exécuter depuis le conteneur Bench avec le site explicitement sélectionné et **après avoir vérifié le propriétaire et l'axe commerciaux**. `--apply` modifie les seuls éléments manquants autorisés ; sans cette option, les scripts auditent et sortent avec le code 2 si la préparation est incomplète.

### 1. Contact

```bash
/path/to/bench/env/bin/python scripts/frappe/init_contact_crm.py \
  --site "${FRAPPE_SITE}" --owner "${CRM_LEAD_OWNER}" --axis "${CRM_DEFAULT_AXIS}"

# Sur décision explicite de l'opérateur, après revue du JSON d'audit :
/path/to/bench/env/bin/python scripts/frappe/init_contact_crm.py \
  --site "${FRAPPE_SITE}" --owner "${CRM_LEAD_OWNER}" --axis "${CRM_DEFAULT_AXIS}" --apply
```

Vérifie les champs Lead natifs et les champs commerciaux, l'utilisateur responsable et son axe, ainsi que le compte email sortant Frappe. Ajoute seulement les `Custom Field` absents avec une configuration prédéfinie. **Ne modifie pas les champs existants, les Leads, les workflows ni les comptes Email Account.**

### 2. Demande de rendez-vous

```bash
/path/to/bench/env/bin/python scripts/frappe/init_meeting_crm.py \
  --site "${FRAPPE_SITE}" --owner "${CRM_LEAD_OWNER}" --axis "${CRM_DEFAULT_AXIS}" \
  --agent "${CRM_BOOKING_AGENT}" --holiday-list "${CRM_HOLIDAY_LIST}" \
  --advance-days 90 --window "Monday=09:00-12:00" --window "Wednesday=14:00-17:00"

# Après validation des règles d'ouverture :
/path/to/bench/env/bin/python scripts/frappe/init_meeting_crm.py \
  --site "${FRAPPE_SITE}" --owner "${CRM_LEAD_OWNER}" --axis "${CRM_DEFAULT_AXIS}" \
  --agent "${CRM_BOOKING_AGENT}" --holiday-list "${CRM_HOLIDAY_LIST}" \
  --advance-days 90 --window "Monday=09:00-12:00" --window "Wednesday=14:00-17:00" --apply
```

Les horaires sont **des exemples**, pas un calendrier métier présumé : remplacer par les disponibilités réellement approuvées. Le script vérifie `Appointment Booking Settings`, `Appointment`, `Event`, `Holiday List`, agents et champs Lead. Il refuse de remplacer un planning existant divergent. **Aucun créneau fictif, Appointment ni Lead n'est créé.**

## Séparation des responsabilités

- Les scripts travaillent sur les **métadonnées Frappe et règles d'agenda**.
- `konektag-api` effectue l'authentification, la limite Redis, le rapprochement/création Lead, la réservation et le courriel client.
- Le Web choisit une date puis une plage `HH:mm–HH:mm+30` retournée par `GET /api/meeting-slots`. La réservation est revalidée dans `POST /api/meeting-request`.
- L'API garde besoin des secrets et des paramètres d'attribution configurés dans **son** namespace ; les scripts Bench ne les définissent pas.
- Les autorisations du compte REST Frappe, le transport Resend, la connexion API réseau et la configuration CPM doivent faire l'objet de contrôles opérationnels séparés.

**Important :** ne pas appliquer automatiquement ces scripts au déploiement ; valider l'audit, l'agent responsable, les jours fériés et le fuseau `Africa/Brazzaville` avec l'équipe métier.
