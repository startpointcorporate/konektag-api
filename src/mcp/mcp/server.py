"""MCP ERPNext Konektag, lecture et écriture contrôlée via OAuth 2.0."""
import os
import base64
import hashlib
from cryptography.fernet import Fernet
from key_value.aio.stores.disk import DiskStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper
from collections import Counter

from fastmcp import FastMCP
from fastmcp.server.auth import OAuthProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier

from erpnext_client import ERPClient
from postiz_client import PostizClient
from cpm_client import CPMClient

REQUIRED = [
    "FRAPPE_URL", "FRAPPE_API_KEY", "FRAPPE_API_SECRET",
    "MCP_PUBLIC_URL", "OAUTH_AUTHORIZE_URL", "OAUTH_TOKEN_URL",
    "OAUTH_CLIENT_ID", "OAUTH_CLIENT_SECRET", "OAUTH_JWKS_URI",
    "OAUTH_ISSUER", "OAUTH_AUDIENCE",
]
missing = [key for key in REQUIRED if not os.environ.get(key)]
if missing:
    raise RuntimeError("Configuration manquante : " + ", ".join(missing))

verifier = JWTVerifier(
    jwks_uri=os.environ["OAUTH_JWKS_URI"],
    issuer=os.environ["OAUTH_ISSUER"],
    audience=os.environ["OAUTH_AUDIENCE"],
)
# Stockage OAuth persistant et chiffré ; clé stable entre les redémarrages.
# Dérivation depuis le secret Keycloak déjà provisionné : pas de nouveau secret à gérer.
_oauth_secret = os.environ["OAUTH_CLIENT_SECRET"].encode("utf-8")
_oauth_store = FernetEncryptionWrapper(
    key_value=DiskStore(directory=os.getenv("OAUTH_STORE_DIR", "/app/data/oauth")),
    fernet=Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"konektag-mcp-storage-v1:" + _oauth_secret).digest())),
)
auth = OAuthProxy(
    jwt_signing_key=hashlib.sha256(b"konektag-mcp-jwt-v1:" + _oauth_secret).hexdigest(),
    client_storage=_oauth_store,
    upstream_authorization_endpoint=os.environ["OAUTH_AUTHORIZE_URL"],
    upstream_token_endpoint=os.environ["OAUTH_TOKEN_URL"],
    upstream_client_id=os.environ["OAUTH_CLIENT_ID"],
    upstream_client_secret=os.environ["OAUTH_CLIENT_SECRET"],
    token_verifier=verifier,
    base_url=os.environ["MCP_PUBLIC_URL"].rstrip("/"),
    extra_authorize_params=(
        {"audience": os.environ["OAUTH_AUDIENCE"]}
        if os.environ.get("OAUTH_SEND_AUDIENCE", "false").lower() == "true" else None
    ),
)
mcp = FastMCP("Konektag ERPNext", auth=auth)

# RFC 8414 path-aware discovery. The installed SDK publishes the unprefixed
# authorization metadata route; reuse that exact handler for a path-based issuer.
from urllib.parse import urlsplit
_public_path = urlsplit(os.environ["MCP_PUBLIC_URL"]).path.rstrip("/")
if _public_path:
    for _route in auth.get_routes("/mcp"):
        if _route.path == "/.well-known/oauth-authorization-server":
            mcp.custom_route("/.well-known/oauth-authorization-server" + _public_path,
                             methods=["GET", "OPTIONS"])(_route.endpoint)

@mcp.tool()
async def digital_audit_list(max_records: int = 500, status: str | None = None,
                             source: str | None = "KONEKTAG Website") -> dict:
    """Liste les demandes d'audit digital enregistrées dans ERPNext (lecture seule).

    complete=false signifie que la pagination a atteint le plafond ;
    ne jamais conclure à une absence de demandes sans couverture complète.
    """
    return await ERPClient().digital_audit_list(max_records=max_records, status=status, source=source)


@mcp.tool()
async def digital_audit_get(audit_id: str) -> dict:
    """Lit une demande Digital Audit et son Contact associé, en lecture seule."""
    return await ERPClient().digital_audit_get(audit_id)


@mcp.tool()
async def digital_audit_audit(max_records: int = 1000,
                              source: str | None = "KONEKTAG Website") -> dict:
    """Synthèse par statut des demandes du site ; indique toute couverture partielle."""
    return await ERPClient().digital_audit_audit(max_records=max_records, source=source)


@mcp.tool()
async def crm_list_leads(max_records: int = 500) -> dict:
    """Liste paginée des Leads. complete=false si le plafond est atteint."""
    return await ERPClient().list("Lead", max_records=max_records)

@mcp.tool()
async def crm_get_lead(lead_id: str) -> dict:
    """Lit une fiche Lead réelle par son identifiant ERPNext."""
    return await ERPClient().get("Lead", lead_id)

@mcp.tool()
async def erp_list_companies(max_records: int = 500) -> dict:
    """Liste les sociétés ERPNext avec pays, devise, abréviation et société parente."""
    return await ERPClient().list_companies(max_records=max_records)


@mcp.tool()
async def erp_create_company(
    company_name: str,
    abbr: str,
    country: str,
    default_currency: str,
    parent_company: str | None = None,
    is_group: bool = False,
    confirm: bool = False,
) -> dict:
    """Crée une société ERPNext après confirmation explicite des paramètres.

    La création ERPNext déclenche la génération de comptes et d'autres valeurs
    comptables par défaut. Confirmer uniquement après validation du nom légal,
    de l'abréviation, du pays, de la devise et du rattachement éventuel.
    """
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().create_company(
        company_name=company_name, abbr=abbr, country=country,
        default_currency=default_currency, parent_company=parent_company,
        is_group=is_group,
    )


@mcp.tool()
async def erp_list_items(company: str, max_records: int = 100) -> dict:
    """Liste les articles ERPNext configurés pour une société via Item Defaults."""
    return await ERPClient().list_items(company, max_records=max_records)


@mcp.tool()
async def erp_get_item(company: str, item_code: str) -> dict:
    """Lit un article et ses paramètres propres à la société demandée."""
    return await ERPClient().get_item(company, item_code)


@mcp.tool()
async def erp_create_item(
    company: str,
    item_code: str,
    item_name: str,
    item_group: str,
    stock_uom: str,
    is_stock_item: bool,
    description: str | None = None,
    is_sales_item: bool = True,
    is_purchase_item: bool = True,
    confirm: bool = False,
) -> dict:
    """Crée un article ERPNext et son Item Default pour la société demandée.

    Les données principales d'Item sont partagées entre sociétés. La création
    ajoute le rattachement à la société dans Item Defaults.
    """
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().create_item(
        company=company, item_code=item_code, item_name=item_name,
        item_group=item_group, stock_uom=stock_uom,
        is_stock_item=is_stock_item, description=description,
        is_sales_item=is_sales_item, is_purchase_item=is_purchase_item,
    )


@mcp.tool()
async def erp_update_item(
    company: str,
    item_code: str,
    changes: dict,
    company_defaults_changes: dict,
    expected_modified: str,
    confirm: bool = False,
) -> dict:
    """Modifie un article après validation et relecture récente.

    Le paramètre changes modifie des champs partagés par toutes les sociétés.
    Le paramètre company_defaults_changes ne touche qu'aux Item Defaults de la société.
    """
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().update_item(
        company=company, item_code=item_code, changes=changes,
        company_defaults_changes=company_defaults_changes,
        expected_modified=expected_modified,
    )


@mcp.tool()
async def crm_search_leads(company_name: str) -> dict:
    """Cherche un prospect dans company_name et lead_name (jamais company)."""
    return await ERPClient().search_leads(company_name)

@mcp.tool()
async def crm_list_contacts(max_records: int = 500) -> dict:
    """Liste les Contacts accessibles, sans inventer de relation Lead-Contact."""
    return await ERPClient().list("Contact", max_records=max_records)


@mcp.tool()
async def crm_search_contacts(email: str | None = None, phone: str | None = None,
                              name: str | None = None) -> dict:
    """Recherche Contacts par email, téléphone ou nom ; correspondance de nom seule = ambiguë."""
    return await ERPClient().search_contacts(email=email, phone=phone, name=name)


@mcp.tool()
async def crm_get_contact(contact_id: str) -> dict:
    """Lit une fiche Contact ERPNext et ses coordonnées."""
    return await ERPClient().get("Contact", contact_id)


@mcp.tool()
async def crm_create_contact(first_name: str, last_name: str | None = None,
                             email: str | None = None, phone: str | None = None,
                             confirm: bool = False) -> dict:
    """Crée un Contact uniquement après validation ; bloque les doublons Contacts/Leads."""
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().create_contact(first_name, last_name, email, phone)


@mcp.tool()
async def crm_update_contact(contact_id: str, changes: dict, expected_modified: str,
                             confirm: bool = False) -> dict:
    """Enrichit un Contact après validation, contrôle de version et anti-doublons."""
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().update_contact(contact_id, changes, expected_modified)


@mcp.tool()
async def crm_audit(max_records: int = 500) -> dict:
    """Répartition vérifiable par étape commerciale et présence d'email sur Lead."""
    extracted = await ERPClient().list("Lead", max_records=max_records)
    leads = extracted["records"]
    stages = Counter((r.get("custom_commercial_stage") or "Étape non renseignée") for r in leads)
    emails = Counter(
        (r.get("custom_commercial_stage") or "Étape non renseignée")
        for r in leads if r.get("email_id")
    )
    return {
        "complete": extracted["complete"],
        "leads": len(leads),
        "unique_ids": len({r["name"] for r in leads}),
        "stages": [
            {"stage": stage, "count": n, "emails_on_lead": emails[stage]}
            for stage, n in sorted(stages.items())
        ],
        "note": "Email sur Lead uniquement; lead_owner est le commercial interne.",
    }

@mcp.tool()
async def postiz_list_posts(start_date: str, end_date: str) -> dict:
    """Publications Postiz : dates ISO UTC, intervalle maximum 31 jours.

    Les posts publiés directement sur les réseaux peuvent être absents.
    L'exhaustivité de la réponse n'est pas garantie.
    """
    return await PostizClient().list_posts(start_date, end_date)


@mcp.tool()
async def postiz_platform_analytics(integration_id: str, days: int) -> dict:
    """Statistiques brutes d'une intégration actuelle, sur 1 à 90 jours.

    Une métrique absente est indisponible ; aucune conversion n'est déduite.
    """
    return await PostizClient().platform_analytics(integration_id, days)


@mcp.tool()
async def postiz_post_analytics(post_id: str, days: int) -> dict:
    """Statistiques brutes d'un post Postiz, sur 1 à 90 jours."""
    return await PostizClient().post_analytics(post_id, days)


@mcp.tool()
async def crm_update_lead(
    lead_id: str,
    changes: dict,
    expected_modified: str,
    confirm: bool = False,
) -> dict:
    """Met à jour un Lead après validation humaine explicite.

    À appeler UNIQUEMENT après présentation et approbation des champs exacts.
    Ne crée pas de Lead. Ne modifie pas lead_owner. Ne transmet pas d'email.
    """
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().update_lead(lead_id, changes, expected_modified)


@mcp.tool()
async def crm_create_lead(
    company_name: str,
    lead_name: str,
    lead_owner: str | None = None,
    email_id: str | None = None,
    custom_axis: str | None = None,
    custom_commercial_stage: str = "À qualifier",
    custom_next_action: str | None = None,
    custom_next_action_date: str | None = None,
    custom_activity_summary: str | None = None,
    confirm: bool = False,
) -> dict:
    """Crée un Lead ERPNext après validation humaine explicite.

    Rechercher le prospect avant de demander la création. confirm=true obligatoire.
    Ne jamais inventer d'email, de contact ou de commercial responsable.
    Retourne l'identifiant ERPNext réel après relecture.
    """
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await ERPClient().create_lead(
        company_name=company_name, lead_name=lead_name, lead_owner=lead_owner,
        email_id=email_id, custom_axis=custom_axis,
        custom_commercial_stage=custom_commercial_stage,
        custom_next_action=custom_next_action,
        custom_next_action_date=custom_next_action_date,
        custom_activity_summary=custom_activity_summary,
    )


@mcp.tool()
async def boost_cpm_list(channel: str | None = None, target_country: str | None = None,
                         billing_company: str | None = None) -> dict:
    """Liste les mappings CPM Konektag par canal, pays cible et société, en lecture seule."""
    return await CPMClient().list(channel, target_country, billing_company)


@mcp.tool()
async def boost_cpm_get(channel: str, target_country: str, billing_company: str) -> dict:
    """Lit le mapping exact, sans prétendre avoir vérifié le tarif ERPNext."""
    return await CPMClient().get(channel, target_country, billing_company)


@mcp.tool()
async def boost_cpm_prices(channel: str, target_country: str,
                           billing_company: str | None = None) -> dict:
    """Liste les CPM réels ERPNext par pays cible et canal, pour une ou toutes les sociétés.

    Lecture par le résolveur métier Konektag ; indique la devise, le prix
    et un statut explicite lorsque le tarif n'est pas vérifiable.
    """
    return await CPMClient().prices(channel, target_country, billing_company)


@mcp.tool()
async def boost_cpm_update(channel: str, target_country: str, billing_company: str,
                           expected_cpm: str, new_cpm: str, confirm: bool = False) -> dict:
    """Modifie le CPM ERPNext après confirmation explicite de l'ancien et du nouveau prix.

    Toujours appeler boost_cpm_prices et présenter les montants à l'utilisateur
    avant d'envoyer confirm=true. La devise est déterminée par le backend.
    """
    if confirm is not True:
        raise PermissionError("Validation explicite requise : confirm=true")
    return await CPMClient().update(channel, target_country, billing_company,
                                    expected_cpm, new_cpm, confirm)


@mcp.tool()
async def boost_cpm_audit() -> dict:
    """Audite les clés de mapping et indique explicitement les vérifications indisponibles."""
    return await CPMClient().audit()


if __name__ == "__main__":
    # Un seul worker/replica initialement, pour le stockage OAuth local.
    mcp.run(transport="http", host=os.getenv("MCP_HOST", "0.0.0.0"), port=int(os.getenv("MCP_PORT", "8000")))
