"""Independent Konektag Microsoft 365 MCP, protected by Keycloak OAuth."""
import os, base64, hashlib, re
from datetime import datetime
from cryptography.fernet import Fernet
from key_value.aio.stores.disk import DiskStore
from key_value.aio.wrappers.encryption import FernetEncryptionWrapper
from fastmcp import FastMCP
from fastmcp.server.auth import OAuthProxy
from fastmcp.server.auth.providers.jwt import JWTVerifier
from graph_client import GraphClient

NEEDED=["M365_CLIENT_ID","M365_TENANT_ID","M365_MAILBOX","OAUTH_AUTHORIZE_URL",
        "OAUTH_TOKEN_URL","OAUTH_CLIENT_ID","OAUTH_CLIENT_SECRET","OAUTH_JWKS_URI",
        "OAUTH_ISSUER","OAUTH_AUDIENCE","MCP_PUBLIC_URL"]
missing=[x for x in NEEDED if not os.getenv(x)]
if missing: raise RuntimeError("Missing: "+", ".join(missing))
secret=os.environ["OAUTH_CLIENT_SECRET"].encode()
store=FernetEncryptionWrapper(
    key_value=DiskStore(directory=os.getenv("OAUTH_STORE_DIR", "/app/data/oauth")),
    fernet=Fernet(base64.urlsafe_b64encode(hashlib.sha256(b"konektag-m365-store-v1:"+secret).digest())))
auth=OAuthProxy(
    jwt_signing_key=hashlib.sha256(b"konektag-m365-jwt-v1:"+secret).hexdigest(),
    client_storage=store,
    upstream_authorization_endpoint=os.environ["OAUTH_AUTHORIZE_URL"],
    upstream_token_endpoint=os.environ["OAUTH_TOKEN_URL"],
    upstream_client_id=os.environ["OAUTH_CLIENT_ID"],
    upstream_client_secret=os.environ["OAUTH_CLIENT_SECRET"],
    token_verifier=JWTVerifier(jwks_uri=os.environ["OAUTH_JWKS_URI"],
                              issuer=os.environ["OAUTH_ISSUER"],
                              audience=os.environ["OAUTH_AUDIENCE"]),
    base_url=os.environ["MCP_PUBLIC_URL"].rstrip("/"),
    extra_authorize_params=({"audience":os.environ["OAUTH_AUDIENCE"]}
        if os.environ.get("OAUTH_SEND_AUDIENCE","false").lower()=="true" else None),
)
mcp=FastMCP("Konektag Microsoft 365",auth=auth)

# RFC 8414 path-aware discovery. The installed SDK publishes the unprefixed
# authorization metadata route; reuse that exact handler for a path-based issuer.
from urllib.parse import urlsplit
_public_path = urlsplit(os.environ["MCP_PUBLIC_URL"]).path.rstrip("/")
if _public_path:
    for _route in auth.get_routes("/mcp"):
        if _route.path == "/.well-known/oauth-authorization-server":
            mcp.custom_route("/.well-known/oauth-authorization-server" + _public_path,
                             methods=["GET", "OPTIONS"])(_route.endpoint)

def _emails(items):
    if not items or len(items)>20: raise ValueError("1 a 20 destinataires requis")
    for x in items:
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+",x):
            raise ValueError("Adresse email invalide")
    return items

@mcp.tool()
async def email_received(top:int=20)->dict:
    """Lire les messages recus de la boite Konektag."""
    return await GraphClient().messages("inbox",top)

@mcp.tool()
async def email_sent(top:int=20)->dict:
    """Lire les messages deja envoyes depuis la boite Konektag."""
    return await GraphClient().messages("sentitems",top)

@mcp.tool()
async def email_read(message_id:str)->dict:
    """Lire le contenu d'un email existant par son identifiant Graph."""
    return await GraphClient().message(message_id)

@mcp.tool()
async def email_send(to:list[str],subject:str,body:str,confirm:bool=False)->dict:
    """Envoyer un email uniquement apres validation explicite du destinataire, sujet et contenu."""
    if confirm is not True: raise PermissionError("confirm=true requis")
    _emails(to)
    if not subject.strip() or not body.strip(): raise ValueError("Sujet et contenu obligatoires")
    result=await GraphClient().send(to,subject,body)
    return {"submitted":True,"recipients":to,"subject":subject,"graph":result,
            "note":"HTTP 202 signifie accepte par Graph, pas livraison garantie"}

@mcp.tool()
async def calendar_list(start_iso:str,end_iso:str,top:int=30)->dict:
    """Lire les evenements sur un intervalle ISO 8601 avec fuseau."""
    a=datetime.fromisoformat(start_iso.replace("Z","+00:00"))
    b=datetime.fromisoformat(end_iso.replace("Z","+00:00"))
    if not a.tzinfo or not b.tzinfo or b<=a: raise ValueError("Intervalle ISO avec fuseau requis")
    return await GraphClient().events(start_iso,end_iso,top)

@mcp.tool()
async def calendar_create(subject:str,start_local:str,end_local:str,
                          timezone:str="Romance Standard Time",body:str="",
                          attendees:list[str]|None=None,confirm:bool=False)->dict:
    """Creer un evenement apres validation explicite ; dates locales sans offset, fuseau Windows Graph."""
    if confirm is not True: raise PermissionError("confirm=true requis")
    a=datetime.fromisoformat(start_local); b=datetime.fromisoformat(end_local)
    if a.tzinfo or b.tzinfo or b<=a: raise ValueError("Dates locales sans offset et fin apres debut")
    if not subject.strip(): raise ValueError("Sujet obligatoire")
    people=_emails(attendees) if attendees else []
    result=await GraphClient().create_event(subject,start_local,end_local,timezone,body,people)
    return {"created":True,"event":result}

if __name__=="__main__":
    mcp.run(transport="http",host=os.getenv("MCP_HOST", "0.0.0.0"),port=int(os.getenv("MCP_PORT", "8000")))
