"""Lectures Postiz bornées. Aucun contenu d'erreur distant ni secret exposé."""
import asyncio
import json
import os
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import urlsplit

import httpx

MAX_BYTES = 2_000_000


class PostizError(RuntimeError):
    pass


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', value):
        raise ValueError('Identifiant invalide (1–128 caractères alphanumériques, _ ou -)')
    return value


def days_parameter(days):
    if type(days) is not int or not 1 <= days <= 90:
        raise ValueError('days doit être un entier entre 1 et 90')
    return days


def date_range(start_date, end_date):
    dates = []
    for value in (start_date, end_date):
        if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)', value):
            raise ValueError('Dates ISO UTC obligatoires')
        dates.append(datetime.fromisoformat(value.replace('Z', '+00:00')))
    if not timedelta(0) < dates[1] - dates[0] <= timedelta(days=31):
        raise ValueError('Intervalle requis : strictement positif, maximum 31 jours')
    return {'startDate': start_date, 'endDate': end_date}


class PostizClient:
    def __init__(self):
        self.base = os.getenv('POSTIZ_API_URL', 'https://postiz.konektag.eu/api/public/v1').rstrip('/')
        url = urlsplit(self.base)
        if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise PostizError('POSTIZ_API_URL doit être une URL HTTPS sans identifiants, query ni fragment')
        self.key = os.getenv('POSTIZ_API_KEY')
        if not self.key:
            raise PostizError('Configuration manquante : POSTIZ_API_KEY')

    async def request(self, path, params=None):
        try:
            return await asyncio.wait_for(self._request(path, params), timeout=30)
        except asyncio.TimeoutError:
            raise PostizError("Timeout total Postiz (30 s)") from None

    async def _request(self, path, params=None):
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=5), follow_redirects=False) as client:
                async with client.stream('GET', self.base + path, params=params,
                                         headers={'Authorization': self.key, 'Accept': 'application/json'}) as response:
                    code = response.status_code
                    if code != 200:
                        reason = {401: 'authentification Postiz refusée', 403: 'permission Postiz refusée',
                                  404: 'endpoint ou ressource indisponible sur cette version',
                                  429: 'limite de requêtes Postiz atteinte'}.get(code, 'erreur API Postiz')
                        raise PostizError(f'{reason} (HTTP {code})')
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_BYTES:
                            raise PostizError('Réponse Postiz trop volumineuse ; réduire la période')
            data = json.loads(body)
            # Ne jamais retransmettre la clé, même si un upstream la reflète.
            def redact(value):
                if isinstance(value, str):
                    return value.replace(self.key, "[REDACTED]")
                if isinstance(value, list):
                    return [redact(item) for item in value]
                if isinstance(value, dict):
                    return {redact(k): redact(v) for k, v in value.items()}
                return value
            data = redact(data)
        except httpx.TimeoutException:
            raise PostizError('Timeout Postiz (connexion 5 s, lecture 25 s)') from None
        except httpx.HTTPError:
            raise PostizError('Transport Postiz indisponible') from None
        except (ValueError, UnicodeError):
            raise PostizError('Réponse Postiz JSON invalide') from None
        if not isinstance(data, (list, dict)):
            raise PostizError('Structure de réponse Postiz invalide')
        return {'data': data, 'retrieved_at': datetime.now(timezone.utc).isoformat(),
                'completeness': 'not_verified',
                'note': 'Données brutes Postiz ; métrique absente/null = indisponible, jamais zéro. Aucune conversion déduite.'}

    async def list_posts(self, start_date, end_date):
        params = date_range(start_date, end_date)
        return await self.request('/posts', params)

    async def platform_analytics(self, integration_id, days):
        return await self.request('/analytics/' + identifier(integration_id), {'date': days_parameter(days)})

    async def post_analytics(self, post_id, days):
        return await self.request('/analytics/post/' + identifier(post_id), {'date': days_parameter(days)})
