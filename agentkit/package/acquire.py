from __future__ import annotations

import argparse
import http.client
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

if __package__ in {None, ""}:
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
    try:
        from runtime.adapters import ADAPTERS
        from runtime.adapters.shared import AdapterFormatError
        from runtime.common import canonical_json, sha256
    except ModuleNotFoundError:
        from package.adapters import ADAPTERS
        from package.adapters.shared import AdapterFormatError
        from package.common import canonical_json, sha256
else:
    from .adapters import ADAPTERS
    from .adapters.shared import AdapterFormatError
    from .common import canonical_json, sha256


VALIDATOR_VERSION = "v2-wire-1"
MAX_PAGE_BYTES = 5_000_000
BUILTIN_HOSTS = {
    "zumper-com": {"zumper.com", "www.zumper.com"},
    "streeteasy-com": {"streeteasy.com", "www.streeteasy.com"},
}
BUILTIN_PORTS = {443}


class AcquisitionError(RuntimeError):
    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class Acquisition:
    status: str
    observations: list[Dict[str, Any]]
    body: bytes
    body_hash: str
    error_class: Optional[str] = None


class SameDestinationRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, allowed_hosts: set[str], allowed_ports: set[int] = BUILTIN_PORTS):
        self.allowed_hosts = {host.casefold() for host in allowed_hosts}
        self.allowed_ports = set(allowed_ports)

    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> Any:
        if not safe_destination(newurl, self.allowed_hosts, self.allowed_ports):
            raise AcquisitionError("redirect", "source redirected outside configured destinations")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def safe_destination(url: str, allowed_hosts: set[str], allowed_ports: set[int]) -> bool:
    try:
        parsed = urllib.parse.urlsplit(url)
        port = parsed.port or 443
    except ValueError:
        return False
    return bool(
        parsed.scheme == "https"
        and parsed.hostname
        and parsed.hostname.casefold() in allowed_hosts
        and parsed.username is None
        and parsed.password is None
        and port in allowed_ports
    )


def fetch(
    query: Dict[str, Any],
    timeout: int = 30,
    loader: Optional[Callable[[str, set[str], int], bytes]] = None,
) -> Acquisition:
    adapter = query.get("adapter")
    payload = query.get("query")
    if (
        adapter not in ADAPTERS
        or not isinstance(payload, dict)
        or not isinstance(payload.get("url"), str)
    ):
        raise AcquisitionError("configuration", "source query is invalid")
    url = payload["url"]
    builtins = BUILTIN_HOSTS[adapter]
    requested = {str(host).casefold() for host in (payload.get("allowed_hosts") or builtins)}
    if not requested <= builtins:
        raise AcquisitionError(
            "configuration", "source destinations cannot expand the adapter host set"
        )
    allowed = requested
    if not safe_destination(url, allowed, BUILTIN_PORTS):
        raise AcquisitionError(
            "configuration", "source URL is outside configured HTTPS destinations"
        )
    try:
        declared_length = None
        if loader:
            page_bytes = loader(url, allowed, timeout)
        else:
            opener = urllib.request.build_opener(SameDestinationRedirect(allowed))
            request = urllib.request.Request(url, headers={"User-Agent": "Homing/2 housing search"})
            with opener.open(request, timeout=timeout) as response:
                if not safe_destination(response.geturl(), allowed, BUILTIN_PORTS):
                    raise AcquisitionError(
                        "redirect", "source response ended outside configured destinations"
                    )
                page_bytes = response.read(MAX_PAGE_BYTES + 1)
                headers = getattr(response, "headers", None)
                raw_length = headers.get("Content-Length") if headers is not None else None
                try:
                    declared_length = int(raw_length) if raw_length is not None else None
                except (TypeError, ValueError):
                    declared_length = None
        if len(page_bytes) > MAX_PAGE_BYTES:
            raise AcquisitionError("partial", "source response exceeded its bound")
        if (
            declared_length is not None
            and declared_length >= 0
            and declared_length > len(page_bytes)
        ):
            raise AcquisitionError("partial", "source response ended before completion")
        page = page_bytes.decode("utf-8")
        observations = ADAPTERS[adapter](page)
    except AcquisitionError:
        raise
    except UnicodeDecodeError as exc:
        raise AcquisitionError("malformed", "source response is not UTF-8") from exc
    except AdapterFormatError as exc:
        raise AcquisitionError("malformed", str(exc)) from exc
    except urllib.error.HTTPError as exc:
        kind = (
            "blocked"
            if exc.code in {401, 403}
            else "unavailable"
            if exc.code >= 500 or exc.code == 429
            else "malformed"
        )
        raise AcquisitionError(kind, "source returned HTTP %d" % exc.code) from exc
    except http.client.IncompleteRead as exc:
        raise AcquisitionError("partial", "source response ended before completion") from exc
    except http.client.RemoteDisconnected as exc:
        raise AcquisitionError("unavailable", "source disconnected before responding") from exc
    except (TimeoutError, socket.timeout) as exc:
        raise AcquisitionError("timeout", "source request timed out") from exc
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, (TimeoutError, socket.timeout)):
            raise AcquisitionError("timeout", "source request timed out") from exc
        raise AcquisitionError("unavailable", "source is unavailable") from exc
    body = b"\n".join(canonical_json(item) for item in observations)
    return Acquisition("completed", observations, body, sha256(body))


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("adapter", choices=sorted(ADAPTERS))
    args = parser.parse_args(argv)
    try:
        query = json.load(sys.stdin)
        if not isinstance(query, dict):
            raise AcquisitionError("configuration", "query must be an object")
        query["adapter"] = args.adapter
        result = fetch(query)
        print(
            json.dumps(
                {
                    "status": result.status,
                    "body_hash": result.body_hash,
                    "observations": result.observations,
                },
                separators=(",", ":"),
            )
        )
        return 0
    except (json.JSONDecodeError, AcquisitionError) as exc:
        kind = getattr(exc, "kind", "configuration")
        print(json.dumps({"status": kind, "error": str(exc)}, separators=(",", ":")))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
