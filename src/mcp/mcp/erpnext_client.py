"""Client REST Frappe, lecture seule, avec pagination et bornes de sécurité."""
import os
import re
from urllib.parse import quote

import httpx

FIELDS = {
    "Lead": ["name","lead_name","company_name","status","lead_owner","email_id",
             "custom_axis","custom_commercial_stage","custom_next_action",
             "custom_next_action_date","custom_activity_summary","custom_last_contact",
             "custom_actual_result","modified","creation"],
    "Contact": ["name","first_name","last_name","full_name","email_id","mobile_no","phone","email_ids","phone_nos","links","modified"],
    "Digital Audit": ["name","request_id","contact","email","company_name","country","city","sector","website","social_links","locale","status","source","requested_at","modified","creation"],
    "Company": ["name","company_name","abbr","country","default_currency","parent_company","is_group","chart_of_accounts","modified","creation"],
    "Item": ["name","item_code","item_name","item_group","stock_uom","is_stock_item","is_sales_item","is_purchase_item","disabled","description","modified","creation","item_defaults"],
}

class ERPClient:
    def __init__(self):
        url = os.environ["FRAPPE_URL"].rstrip("/")
        if not url.startswith("https://"):
            raise RuntimeError("FRAPPE_URL doit utiliser HTTPS")
        self.base = url
        self.token = os.environ["FRAPPE_API_KEY"] + ":" + os.environ["FRAPPE_API_SECRET"]

    async def request(self, path, params=None, *, method="GET", payload=None):
        async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
            response = await client.request(
                method, self.base + path, params=params, json=payload,
                headers={"Authorization": "token " + self.token, "Accept": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
            if "data" not in data:
                raise RuntimeError("Réponse Frappe sans data")
            return data["data"]

    async def list(self, doctype, *, max_records=500, filters=None):
        if doctype not in FIELDS:
            raise ValueError("Doctype non autorisé")
        if not 1 <= max_records <= 1000:
            raise ValueError("max_records doit être compris entre 1 et 1000")
        result = []
        for offset in range(0, max_records, 100):
            limit = min(100, max_records - offset)
            params = {
                "fields": __import__("json").dumps(["*"]),
                "limit_start": offset,
                "limit_page_length": limit,
                "order_by": "creation asc",
            }
            if filters is not None:
                params["filters"] = __import__("json").dumps(filters)
            page = await self.request("/api/resource/" + quote(doctype, safe=""), params)
            if not isinstance(page, list):
                raise RuntimeError("Liste Frappe invalide")
            result.extend([{k: item.get(k) for k in FIELDS[doctype]} for item in page])
            if len(page) < limit:
                return {"records": result, "complete": True, "returned": len(result)}
        # Au plafond, l'exhaustivité n'est pas démontrée.
        return {"records": result, "complete": False, "returned": len(result)}

    async def get(self, doctype, name):
        if doctype not in FIELDS:
            raise ValueError("Doctype non autorisé")
        record = await self.request("/api/resource/" + quote(doctype, safe="") + "/" + quote(name, safe=""))
        if not isinstance(record, dict):
            raise RuntimeError("Fiche Frappe invalide")
        return {k: record.get(k) for k in FIELDS[doctype]}


    async def digital_audit_list(self, max_records=500, status=None, source="KONEKTAG Website"):
        """Liste les demandes d'audit, bornée et paginée ; aucune écriture."""
        if status is not None and (not isinstance(status, str) or not re.fullmatch(r"[A-Za-z_ ]{1,40}", status)):
            raise ValueError("Statut d'audit invalide")
        if source is not None and (not isinstance(source, str) or len(source) > 100):
            raise ValueError("Source d'audit invalide")
        filters = []
        if status: filters.append(["Digital Audit", "status", "=", status])
        if source: filters.append(["Digital Audit", "source", "=", source])
        return await self.list("Digital Audit", max_records=max_records, filters=filters)

    async def digital_audit_get(self, audit_id):
        """Lit une demande identifiée et son Contact lié, sans mutation."""
        if not isinstance(audit_id, str) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,140}", audit_id):
            raise ValueError("Identifiant d'audit invalide")
        audit = await self.get("Digital Audit", audit_id)
        contact = await self.get("Contact", audit["contact"]) if audit.get("contact") else None
        return {"audit": audit, "contact": contact}

    async def digital_audit_audit(self, max_records=1000, source="KONEKTAG Website"):
        """Comptage des statuts ; ne prétend pas être exhaustif si plafond atteint."""
        data = await self.digital_audit_list(max_records=max_records, source=source)
        counts = {}
        for record in data["records"]:
            status = record.get("status") or "NON_RENSEIGNE"
            counts[status] = counts.get(status, 0) + 1
        return {"source": source, "total": data["returned"], "by_status": counts,
                "complete": data["complete"], "max_records": max_records,
                "note": "Si complete=false, les totaux sont partiels."}

    @staticmethod
    def _email(value):
        value = (value or "").strip().casefold()
        if value and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", value):
            raise ValueError("Adresse email invalide")
        return value

    @staticmethod
    def _phone(value):
        value = re.sub(r"[\s().-]", "", value or "")
        if value and not re.fullmatch(r"\+?[0-9]{7,15}", value):
            raise ValueError("Téléphone invalide")
        return value

    @staticmethod
    def _contact_keys(row):
        emails = {str(x).strip().casefold() for x in [row.get("email_id")] if x}
        phones = {re.sub(r"[\s().-]", "", str(x)) for x in
                  (row.get("phone"), row.get("mobile_no")) if x}
        for x in row.get("email_ids") or []:
            if x.get("email_id"): emails.add(x["email_id"].strip().casefold())
        for x in row.get("phone_nos") or []:
            if x.get("phone"): phones.add(re.sub(r"[\s().-]", "", x["phone"]))
        return emails, phones

    async def search_contacts(self, email=None, phone=None, name=None):
        """Fail closed on incomplete pagination; return candidate records, never guess identity."""
        email = self._email(email)
        phone = self._phone(phone)
        name = (name or "").strip().casefold()
        if not any((email, phone, name)):
            raise ValueError("Au moins un critère de recherche est requis")
        if name and len(name) < 3:
            raise ValueError("Nom trop court")
        listing = await self.list("Contact", max_records=1000)
        if not listing["complete"]:
            raise RuntimeError("Inventaire Contact incomplet : rapprochement non garanti")
        found = []
        for row in listing["records"]:
            emails, phones = self._contact_keys(row)
            full = (row.get("full_name") or " ".join(filter(None, [row.get("first_name"), row.get("last_name")]))).strip().casefold()
            reasons = []
            if email and email in emails: reasons.append("email")
            if phone and phone in phones: reasons.append("phone")
            if name and name == full: reasons.append("name_only")
            if reasons: found.append({"contact": row, "matched_on": reasons})
        return {"records": found, "returned": len(found), "complete": True}

    async def _lead_collision(self, email):
        if not email:
            return []
        listing = await self.list("Lead", max_records=1000)
        if not listing["complete"]:
            raise RuntimeError("Inventaire Lead incomplet : création interdite")
        return [row for row in listing["records"]
                if (row.get("email_id") or "").strip().casefold() == email]

    async def create_contact(self, first_name, last_name=None, email=None, phone=None):
        first_name = (first_name or "").strip()
        last_name = (last_name or "").strip()
        email = self._email(email)
        phone = self._phone(phone)
        if len(first_name) < 2 or not (email or phone):
            raise ValueError("Prénom et au moins un email ou téléphone obligatoires")
        existing = await self.search_contacts(email=email or None, phone=phone or None,
                                              name=" ".join(filter(None, [first_name, last_name])))
        if existing["records"]:
            raise ValueError("Contact potentiellement existant : création bloquée ; examiner crm_search_contacts")
        lead_matches = await self._lead_collision(email)
        if lead_matches:
            raise ValueError("Lead avec cet email déjà existant : " + ", ".join(x["name"] for x in lead_matches))
        payload = {"first_name": first_name}
        if last_name: payload["last_name"] = last_name
        if email: payload["email_ids"] = [{"email_id": email, "is_primary": 1}]
        if phone: payload["phone_nos"] = [{"phone": phone, "is_primary_phone": 1}]
        created = await self.request("/api/resource/Contact", method="POST", payload=payload)
        if not isinstance(created, dict) or not created.get("name"):
            raise RuntimeError("Création Contact sans identifiant")
        after = await self.get("Contact", created["name"])
        emails, phones = self._contact_keys(after)
        if (email and email not in emails) or (phone and phone not in phones):
            raise RuntimeError("Contact créé, mais vérification des coordonnées échouée")
        return {"contact_id": after["name"], "verified": True, "record": after}

    async def update_contact(self, contact_id, changes, expected_modified):
        """Preserve existing child rows, and reject conflicting identity keys."""
        allowed = {"first_name", "last_name", "email", "phone"}
        if not isinstance(changes, dict) or not changes or set(changes) - allowed:
            raise ValueError("Champs Contact non autorisés")
        current = await self.request("/api/resource/Contact/" + quote(contact_id, safe=""))
        if current.get("modified") != expected_modified:
            raise ValueError("Conflit : Contact modifié depuis la lecture")
        payload = {}
        for field in ("first_name", "last_name"):
            if field in changes:
                value = changes[field]
                if not isinstance(value, str) or (field == "first_name" and len(value.strip()) < 2):
                    raise ValueError("Nom invalide")
                payload[field] = value.strip()
        if "email" in changes:
            email = self._email(changes["email"])
            if not email: raise ValueError("Suppression email non autorisée")
            existing = await self.search_contacts(email=email)
            if any(x["contact"]["name"] != contact_id for x in existing["records"]):
                raise ValueError("Email déjà utilisé par un autre Contact")
            if await self._lead_collision(email):
                raise ValueError("Email associé à un Lead : rapprochement manuel requis")
            rows = list(current.get("email_ids") or [])
            if email not in {x.get("email_id", "").casefold() for x in rows}:
                rows.append({"email_id": email, "is_primary": 0 if rows else 1})
            payload["email_ids"] = rows
        if "phone" in changes:
            phone = self._phone(changes["phone"])
            if not phone: raise ValueError("Suppression téléphone non autorisée")
            existing = await self.search_contacts(phone=phone)
            if any(x["contact"]["name"] != contact_id for x in existing["records"]):
                raise ValueError("Téléphone déjà utilisé par un autre Contact")
            rows = list(current.get("phone_nos") or [])
            if phone not in {self._phone(x.get("phone")) for x in rows}:
                rows.append({"phone": phone, "is_primary_phone": 0 if rows else 1})
            payload["phone_nos"] = rows
        await self.request("/api/resource/Contact/" + quote(contact_id, safe=""),
                           method="PUT", payload=payload)
        after = await self.get("Contact", contact_id)
        emails, phones = self._contact_keys(after)
        if ("email" in changes and self._email(changes["email"]) not in emails or
                "phone" in changes and self._phone(changes["phone"]) not in phones):
            raise RuntimeError("Modification effectuée, relecture incohérente")
        return {"contact_id": contact_id, "verified": True, "record": after}

    async def list_items(self, company, *, max_records=100):
        """Liste les Items dont les defaults sont configurés pour cette société."""
        company = (company or "").strip()
        if not company:
            raise ValueError("Société obligatoire")
        if not 1 <= max_records <= 100:
            raise ValueError("max_records doit être compris entre 1 et 100")
        await self.get("Company", company)
        result = await self.list(
            "Item", max_records=max_records,
            filters=[["Item Default", "company", "=", company]],
        )
        return {
            **result,
            "company": company,
            "records": result["records"],
            "scope": "Items configurés pour cette société via Item Defaults",
        }

    async def get_item(self, company, item_code):
        """Lit un Item uniquement s'il comporte un défaut pour la société demandée."""
        company = (company or "").strip()
        item_code = (item_code or "").strip()
        if not company or not item_code:
            raise ValueError("Société et code article obligatoires")
        await self.get("Company", company)
        record = await self.request("/api/resource/Item/" + quote(item_code, safe=""))
        if not isinstance(record, dict):
            raise RuntimeError("Fiche Item Frappe invalide")
        defaults = record.get("item_defaults") or []
        scoped = [row for row in defaults if row.get("company") == company]
        if not scoped:
            raise ValueError("Cet article n'est pas configuré pour la société demandée")
        return {
            **{key: record.get(key) for key in FIELDS["Item"] if key != "item_defaults"},
            "company": company,
            "company_defaults": scoped[0],
        }

    async def create_item(self, company, item_code, item_name, item_group, stock_uom,
                          is_stock_item, description=None, is_sales_item=True,
                          is_purchase_item=True):
        """Crée un Item global avec une ligne Item Default pour la société choisie."""
        company = (company or "").strip()
        item_code = (item_code or "").strip()
        item_name = (item_name or "").strip()
        item_group = (item_group or "").strip()
        stock_uom = (stock_uom or "").strip()
        if not all([company, item_code, item_name, item_group, stock_uom]):
            raise ValueError("Société, code, nom, groupe d'articles et unité de stock obligatoires")
        if any(not isinstance(value, bool) for value in (is_stock_item, is_sales_item, is_purchase_item)):
            raise ValueError("Les indicateurs article doivent être booléens")
        await self.get("Company", company)
        existing = await self.list("Item", max_records=1000)
        if not existing["complete"]:
            raise RuntimeError("Recherche d'articles incomplète : création interdite")
        if any(item.get("name") == item_code or item.get("item_code") == item_code
               for item in existing["records"]):
            raise ValueError("Code article déjà utilisé : " + item_code)
        payload = {
            "item_code": item_code,
            "item_name": item_name,
            "item_group": item_group,
            "stock_uom": stock_uom,
            "is_stock_item": int(is_stock_item),
            "is_sales_item": int(is_sales_item),
            "is_purchase_item": int(is_purchase_item),
            "item_defaults": [{"company": company}],
        }
        if description is not None:
            payload["description"] = description
        created = await self.request("/api/resource/Item", method="POST", payload=payload)
        if not isinstance(created, dict) or not created.get("name"):
            raise RuntimeError("ERPNext n'a pas retourné d'identifiant Item")
        after = await self.get_item(company, created["name"])
        expected = {
            "item_code": item_code, "item_name": item_name,
            "item_group": item_group, "stock_uom": stock_uom,
        }
        if any(after.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Création effectuée mais relecture incohérente")
        return {"item_code": created["name"], "company": company, "verified": True, "record": after}

    async def update_item(self, company, item_code, changes, company_defaults_changes,
                          expected_modified):
        """Modifie les champs globaux explicitement autorisés et/ou les defaults de la société."""
        company = (company or "").strip()
        item_code = (item_code or "").strip()
        global_allowed = {"item_name", "description", "is_sales_item", "is_purchase_item", "disabled"}
        defaults_allowed = {
            "default_warehouse", "default_price_list", "buying_cost_center",
            "selling_cost_center", "income_account", "expense_account", "default_supplier",
        }
        if not company or not item_code:
            raise ValueError("Société et code article obligatoires")
        if not isinstance(changes, dict) or not isinstance(company_defaults_changes, dict):
            raise ValueError("Les modifications doivent être des objets")
        if not changes and not company_defaults_changes:
            raise ValueError("Aucune modification fournie")
        if set(changes) - global_allowed or set(company_defaults_changes) - defaults_allowed:
            raise ValueError("Champ Item ou Item Default non autorisé")
        if any(not isinstance(value, bool) for key, value in changes.items()
               if key in {"is_sales_item", "is_purchase_item", "disabled"}):
            raise ValueError("Les indicateurs article doivent être booléens")
        current = await self.request("/api/resource/Item/" + quote(item_code, safe=""))
        if not isinstance(current, dict):
            raise RuntimeError("Fiche Item Frappe invalide")
        if current.get("modified") != expected_modified:
            raise ValueError("Conflit : article modifié depuis la lecture précédente")
        defaults = current.get("item_defaults") or []
        match = next((row for row in defaults if row.get("company") == company), None)
        if not match:
            raise ValueError("Cet article n'est pas configuré pour la société demandée")
        payload = dict(changes)
        if company_defaults_changes:
            # Préserve les réglages des autres sociétés : Item est un document global.
            child_fields = {"name", "company"} | defaults_allowed
            kept = [{key: row[key] for key in child_fields if key in row}
                    for row in defaults]
            for row in kept:
                if row.get("company") == company:
                    row.update(company_defaults_changes)
            payload["item_defaults"] = kept
        await self.request("/api/resource/Item/" + quote(item_code, safe=""),
                           method="PUT", payload=payload)
        after = await self.get_item(company, item_code)
        if any(after.get(key) != value for key, value in changes.items()):
            raise RuntimeError("Écriture effectuée mais vérification Item échouée")
        if any(after["company_defaults"].get(key) != value
               for key, value in company_defaults_changes.items()):
            raise RuntimeError("Écriture effectuée mais vérification Item Default échouée")
        return {
            "item_code": item_code, "company": company, "verified": True,
            "modified": after.get("modified"),
            "updated_fields": list(changes),
            "updated_company_default_fields": list(company_defaults_changes),
        }

    async def list_companies(self, *, max_records=500):
        """Liste bornée des sociétés et de leurs paramètres principaux."""
        return await self.list("Company", max_records=max_records)

    async def create_company(self, company_name, abbr, country, default_currency,
                             parent_company=None, is_group=False):
        """Création explicite d'une Company, avec vérification de doublons et relecture."""
        company_name = (company_name or "").strip()
        abbr = (abbr or "").strip()
        country = (country or "").strip()
        default_currency = (default_currency or "").strip().upper()
        if len(company_name) < 2:
            raise ValueError("Nom légal de société obligatoire")
        if not abbr or len(abbr) > 10 or not abbr.replace("-", "").isalnum():
            raise ValueError("Abréviation invalide (1 à 10 caractères alphanumériques ou tiret)")
        if len(country) < 2 or len(default_currency) != 3 or not default_currency.isalpha():
            raise ValueError("Pays et devise ISO 4217 obligatoires")
        if not isinstance(is_group, bool):
            raise ValueError("is_group doit être booléen")
        companies = await self.list("Company", max_records=1000)
        if not companies["complete"]:
            raise RuntimeError("Recherche de doublons incomplète : création interdite")
        duplicates = [row for row in companies["records"]
                      if (row.get("company_name") or row.get("name") or "").strip().casefold()
                      == company_name.casefold()]
        if duplicates:
            raise ValueError("Société existante : " + ", ".join(row["name"] for row in duplicates))
        abbr_duplicates = [row for row in companies["records"]
                           if (row.get("abbr") or "").strip().casefold() == abbr.casefold()]
        if abbr_duplicates:
            raise ValueError("Abréviation déjà utilisée : " + ", ".join(row["name"] for row in abbr_duplicates))
        payload = {
            "company_name": company_name,
            "abbr": abbr,
            "country": country,
            "default_currency": default_currency,
            "is_group": int(is_group),
        }
        if parent_company:
            known = {row["name"] for row in companies["records"]}
            if parent_company not in known:
                raise ValueError("Société parente inconnue dans la liste ERPNext")
            payload["parent_company"] = parent_company
        created = await self.request("/api/resource/Company", method="POST", payload=payload)
        if not isinstance(created, dict) or not created.get("name"):
            raise RuntimeError("ERPNext n'a pas retourné d'identifiant Company")
        after = await self.get("Company", created["name"])
        expected = {
            "company_name": company_name, "abbr": abbr, "country": country,
            "default_currency": default_currency, "is_group": int(is_group),
        }
        if any(after.get(key) != value for key, value in expected.items()):
            raise RuntimeError("Création effectuée mais relecture incohérente")
        return {"company_id": after["name"], "verified": True, "record": after}

    async def search_leads(self, company_name, limit=100):
        if not company_name or len(company_name.strip()) < 2:
            raise ValueError("Nom de société trop court")
        # Recherche partielle explicite sur les deux champs métier, sans champ company.
        from urllib.parse import quote as _q
        results = {}
        complete = True
        for field in ("company_name", "lead_name"):
            found = await self.list("Lead", max_records=limit, filters=[[field, "like", "%" + company_name.strip() + "%"]])
            complete = complete and found["complete"]
            for lead in found["records"]:
                results[lead["name"]] = lead
        return {"records": list(results.values()), "complete": complete, "returned": len(results)}

    async def lead_commercial_stages(self):
        """Load effective Lead Select options from Frappe; fail closed on errors."""
        from urllib.parse import urlencode
        # This Frappe RPC returns {docs: ...}, not the {data: ...} envelope
        # enforced by request() for /api/resource endpoints.
        path = "/api/method/frappe.desk.form.load.getdoctype?" + urlencode({"doctype": "Lead"})
        async with httpx.AsyncClient(timeout=25, follow_redirects=False) as client:
            response = await client.get(
                self.base + path,
                headers={"Authorization": "token " + self.token, "Accept": "application/json"},
            )
            response.raise_for_status()
            data = response.json()
        docs = data if isinstance(data, list) else data.get("docs") if isinstance(data, dict) else None
        if not isinstance(docs, list):
            raise RuntimeError("Métadonnées Lead indisponibles")
        fields = []
        for doc in docs:
            if doc.get("doctype") == "DocType" and doc.get("name") == "Lead":
                fields.extend(doc.get("fields") or [])
            elif doc.get("doctype") == "Custom Field" and doc.get("dt") == "Lead":
                fields.append(doc)
        matches = [f for f in fields if f.get("fieldname") == "custom_commercial_stage"]
        if len(matches) != 1:
            raise RuntimeError("Champ commercial Lead introuvable ou ambigu")
        options = matches[0].get("options") or ""
        overrides = [d for d in docs if d.get("doctype") == "Property Setter"
                     and d.get("doc_type") == "Lead" and d.get("field_name") == "custom_commercial_stage"
                     and d.get("property") == "options"]
        if len(overrides) > 1:
            raise RuntimeError("Options commerciales ambiguës")
        if overrides:
            options = overrides[0].get("value") or ""
        stages = {value.strip() for value in options.splitlines() if value.strip()}
        if not stages:
            raise RuntimeError("Aucune étape commerciale configurée dans ERPNext")
        return stages

    async def update_lead(self, lead_id, changes, expected_modified):
        """Update contrôlé, uniquement après validation explicite de l'utilisateur."""
        if not lead_id.startswith("CRM-LEAD-"):
            raise ValueError("Identifiant Lead invalide")
        allowed = {"custom_next_action", "custom_next_action_date",
                   "custom_activity_summary", "custom_commercial_stage",
                   "custom_last_contact", "custom_actual_result"}
        if not isinstance(changes, dict) or not changes or set(changes) - allowed:
            raise ValueError("Champs de mise à jour non autorisés")
        current = await self.get("Lead", lead_id)
        if current.get("modified") != expected_modified:
            raise ValueError("Conflit : fiche modifiée depuis la lecture précédente")
        if "custom_activity_summary" in changes:
            previous = current.get("custom_activity_summary") or ""
            updated = changes["custom_activity_summary"]
            if not isinstance(updated, str) or not updated.startswith(previous) or len(updated) <= len(previous):
                raise ValueError("L'historique commercial doit être conservé et enrichi")
        if "custom_next_action_date" in changes and changes["custom_next_action_date"]:
            from datetime import date
            date.fromisoformat(changes["custom_next_action_date"])
        if "custom_last_contact" in changes:
            from datetime import datetime
            value = changes["custom_last_contact"]
            if not isinstance(value, str) or not value.strip():
                raise ValueError("Date du dernier contact obligatoire")
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        if "custom_actual_result" in changes:
            value = changes["custom_actual_result"]
            if not isinstance(value, str) or not value.strip() or len(value) > 500:
                raise ValueError("Résultat du contact obligatoire (500 caractères max)")
        if "custom_commercial_stage" in changes:
            # Ne jamais créer une nouvelle valeur Kanban à partir d'une suggestion du LLM.
            stages = await self.lead_commercial_stages()
            if changes["custom_commercial_stage"] not in stages:
                raise ValueError("Étape commerciale non autorisée")
        path = "/api/resource/Lead/" + quote(lead_id, safe="")
        await self.request(path, method="PUT", payload=changes)
        after = await self.get("Lead", lead_id)
        if any(after.get(k) != v for k,v in changes.items()):
            raise RuntimeError("Écriture effectuée mais vérification de relecture échouée")
        return {"lead_id": lead_id, "verified": True,
                "modified": after.get("modified"), "updated_fields": list(changes)}

    async def create_lead(self, company_name, lead_name, lead_owner=None,
                          email_id=None, custom_axis=None, custom_commercial_stage="À qualifier",
                          custom_next_action=None, custom_next_action_date=None,
                          custom_activity_summary=None):
        """Création contrôlée : pas de doublon, aucun contact fictif."""
        from datetime import date
        import re
        company_name = (company_name or "").strip()
        lead_name = (lead_name or company_name).strip()
        if len(company_name) < 2 or len(lead_name) < 2:
            raise ValueError("Nom de société et nom du Lead obligatoires")
        if email_id and not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email_id):
            raise ValueError("Email invalide")
        if custom_next_action_date:
            date.fromisoformat(custom_next_action_date)
        stages = await self.lead_commercial_stages()
        if custom_commercial_stage not in stages:
            raise ValueError("Étape commerciale non autorisée")
        if custom_axis and custom_axis not in {
            "AXE_1_INCUBATION", "AXE_2_PARTENARIAT_CONGO",
            "AXE_3_MARKETPLACE_CONGO", "AXE_4_DIASPORA", "AXE_5_EUROPE"
        }:
            raise ValueError("Axe commercial non autorisé")
        # Le filtrage exact sur company_name évite les collisions de recherche partielle.
        matches = await self.list("Lead", max_records=1000)
        if not matches["complete"]:
            raise RuntimeError("Recherche de doublons incomplète : création interdite")
        duplicates = [x for x in matches["records"] if company_name.casefold() in
                      {(x.get("company_name") or "").strip().casefold(),
                       (x.get("lead_name") or "").strip().casefold()}]
        if duplicates:
            raise ValueError("Lead existant : " + ", ".join(x["name"] for x in duplicates))
        payload = {"company_name": company_name, "lead_name": lead_name,
                   "custom_commercial_stage": custom_commercial_stage}
        optional = {"lead_owner": lead_owner, "email_id": email_id,
                    "custom_axis": custom_axis, "custom_next_action": custom_next_action,
                    "custom_next_action_date": custom_next_action_date,
                    "custom_activity_summary": custom_activity_summary}
        payload.update({k: v for k, v in optional.items() if v is not None})
        created = await self.request("/api/resource/Lead", method="POST", payload=payload)
        if not isinstance(created, dict) or not created.get("name"):
            raise RuntimeError("ERPNext n'a pas retourné d'identifiant Lead")
        after = await self.get("Lead", created["name"])
        if after.get("company_name") != company_name:
            raise RuntimeError("Création effectuée mais relecture incohérente")
        return {"lead_id": after["name"], "verified": True, "record": after}
