"""Microsoft Graph using Entra application certificate (app-only)."""
import os
from pathlib import Path
from urllib.parse import quote
import httpx
import msal
from cryptography.hazmat.primitives.serialization import Encoding, PrivateFormat, NoEncryption
from cryptography.hazmat.primitives.serialization.pkcs12 import load_key_and_certificates
from cryptography.hazmat.primitives import hashes

MAILBOX = os.environ.get("M365_MAILBOX", "info-konektag@konektag.eu")
BASE = "https://graph.microsoft.com/v1.0"
def _user():
    return "/users/" + quote(MAILBOX, safe="@")

class GraphClient:
    def __init__(self):
        raw = Path(os.environ.get("M365_PFX_PATH", "/run/m365/m365.pfx")).read_bytes()
        password = os.environ.get("M365_PFX_PASSWORD")
        key, cert, _ = load_key_and_certificates(raw, password.encode() if password else None)
        if not key or not cert:
            raise RuntimeError("PFX: certificat ou cle privee manquant")
        pem = key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8, NoEncryption()).decode()
        thumb = cert.fingerprint(hashes.SHA1()).hex()
        self.app = msal.ConfidentialClientApplication(
            os.environ["M365_CLIENT_ID"],
            authority="https://login.microsoftonline.com/" + os.environ["M365_TENANT_ID"],
            client_credential={"private_key": pem, "thumbprint": thumb},
        )
    def token(self):
        r = self.app.acquire_token_for_client(scopes=["https://graph.microsoft.com/.default"])
        if "access_token" not in r:
            raise RuntimeError("Microsoft Graph auth: " + str(r.get("error_description", r.get("error", "unknown")))[:350])
        return r["access_token"]
    async def request(self, method, path, *, params=None, json=None):
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.request(method, BASE + path, params=params, json=json,
                headers={"Authorization":"Bearer "+self.token(), "Accept":"application/json"})
        if r.is_error:
            try:
                err = r.json().get("error", {})
                msg = err.get("message", "") if isinstance(err, dict) else ""
            except ValueError:
                msg = r.text[:200]
            raise RuntimeError(f"Microsoft Graph HTTP {r.status_code}: {msg[:400]}")
        if r.status_code == 202 or not r.content:
            return {"accepted": True, "http_status": r.status_code}
        return r.json()
    async def messages(self, folder, top):
        if folder not in ("inbox","sentitems"):
            raise ValueError("Dossier invalide")
        return await self.request("GET",_user()+"/mailFolders/"+folder+"/messages",
            params={"$top":max(1,min(top,100)),"$orderby":"receivedDateTime desc" if folder=="inbox" else "sentDateTime desc",
                    "$select":"id,subject,from,toRecipients,receivedDateTime,sentDateTime,bodyPreview,webLink"})
    async def message(self, message_id):
        return await self.request("GET",_user()+"/messages/"+quote(message_id,safe=""),
            params={"$select":"id,subject,from,toRecipients,receivedDateTime,sentDateTime,body,webLink"})
    async def send(self, to, subject, body):
        return await self.request("POST",_user()+"/sendMail",
            json={"message":{"subject":subject,"body":{"contentType":"Text","content":body},
                "toRecipients":[{"emailAddress":{"address":email}} for email in to]},"saveToSentItems":True})
    async def events(self, start, end, top):
        return await self.request("GET",_user()+"/calendarView",
            params={"startDateTime":start,"endDateTime":end,"$top":max(1,min(top,100)),
                    "$select":"id,subject,start,end,location,organizer,webLink,isOnlineMeeting,onlineMeetingUrl"})
    async def create_event(self, subject, start, end, timezone, body, attendees):
        payload={"subject":subject,"start":{"dateTime":start,"timeZone":timezone},
                 "end":{"dateTime":end,"timeZone":timezone},
                 "body":{"contentType":"Text","content":body},
                 "attendees":[{"emailAddress":{"address":x},"type":"required"} for x in attendees]}
        return await self.request("POST",_user()+"/events",json=payload)
