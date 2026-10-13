"""Canonical durable relay controls; failures never substitute local defaults."""
from __future__ import annotations

import json
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

_MAX_BODY = 4096
_TIMEOUT = 5


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _canonical(value: object) -> dict:
    if (not isinstance(value, dict) or set(value) != {'paused', 'forced', 'auto_start'}
            or type(value['paused']) is not bool
            or type(value['auto_start']) is not bool
            or value['forced'] not in (None, 'rwitc', 'turbosportslive')):
        raise ValueError('Invalid relay state')
    return {'paused': value['paused'], 'forced': value['forced'],
            'auto_start': value['auto_start']}


def _request(url: str, token: str, state: dict | None) -> dict:
    try:
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('invalid endpoint')
        if not isinstance(token, str) or not token or '\r' in token or '\n' in token:
            raise ValueError('invalid authorization')
        data = None if state is None else json.dumps(state, separators=(',', ':')).encode('utf-8')
        request = Request(url, data=data, method='GET' if state is None else 'PUT', headers={
            'Authorization': f'Bearer {token}', 'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (compatible; rrr-relay/1.0)',
        })
        with build_opener(_NoRedirect()).open(request, timeout=_TIMEOUT) as response:
            if response.status != 200:
                raise ValueError('unexpected status')
            body = response.read(_MAX_BODY + 1)
        if len(body) > _MAX_BODY:
            raise ValueError('oversized response')
        return _canonical(json.loads(body.decode('utf-8')))
    except HTTPError as error:
        error.close()
        raise RuntimeError('Relay state service unavailable') from None
    except Exception:
        # Do not expose URLs, bearer headers, service bodies, or nested errors.
        raise RuntimeError('Relay state service unavailable or returned invalid state') from None


def load_state(url: str, token: str) -> dict:
    """Load canonical controls; raise RuntimeError if durable state is unavailable."""
    return _request(url, token, None)


def save_state(url: str, token: str, state: dict) -> None:
    """Persist all controls atomically; invalid input never reaches the service."""
    canonical = _canonical(state)
    saved = _request(url, token, canonical)
    if saved != canonical:
        raise RuntimeError('Relay state service did not confirm saved state')
