from __future__ import annotations

import argparse
import json
import socket
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional, Tuple

try:
    from .common import ContractError, parse_verified_json
except ImportError:
    from common import ContractError, parse_verified_json

ORIGIN = "__HOMING_ORIGIN__"


class HomingError(RuntimeError):
    def __init__(self, kind: str, message: str, retryable: bool = False):
        super().__init__(message)
        self.kind = kind
        self.retryable = retryable


@dataclass(frozen=True)
class Response:
    status: int
    body: bytes
    headers: Dict[str, str]


def keychain_token(service: str, account: str) -> str:
    process = subprocess.run(
        ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        env={"PATH": "/usr/bin:/bin"},
        timeout=10,
    )
    if process.returncode != 0 or not process.stdout.strip():
        raise HomingError("authentication", "Homing credential is unavailable")
    return process.stdout.strip()


class HomingClient:
    """The only runtime component allowed to read the Homing credential."""

    def __init__(
        self,
        origin: str,
        token_provider: Callable[[], str],
        timeout: int = 30,
        transport: Optional[Callable[..., Response]] = None,
    ):
        parsed = urllib.parse.urlsplit(origin)
        try:
            port = parsed.port or 443
        except ValueError as exc:
            raise ValueError("Homing origin has an invalid port") from exc
        if (
            parsed.scheme != "https"
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path not in {"", "/"}
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Homing origin must be an HTTPS origin")
        self.origin = origin.rstrip("/")
        self.origin_host = parsed.hostname.casefold()
        self.origin_port = port
        self.token_provider = token_provider
        self.timeout = timeout
        self.transport = transport or self._transport

    def _transport(
        self, method: str, url: str, body: Optional[bytes], headers: Dict[str, str]
    ) -> Response:
        request = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:

            class OriginRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(
                    inner_self,
                    req: Any,
                    fp: Any,
                    code: int,
                    msg: str,
                    response_headers: Any,
                    newurl: str,
                ) -> Any:
                    final = urllib.parse.urlsplit(newurl)
                    try:
                        final_port = final.port or 443
                    except ValueError:
                        final_port = -1
                    if (
                        final.scheme != "https"
                        or not final.hostname
                        or final.hostname.casefold() != self.origin_host
                        or final_port != self.origin_port
                        or final.username is not None
                        or final.password is not None
                    ):
                        raise HomingError(
                            "redirect", "Homing redirected outside its configured origin"
                        )
                    return super().redirect_request(req, fp, code, msg, response_headers, newurl)

            opener = urllib.request.build_opener(OriginRedirect())
            with opener.open(request, timeout=self.timeout) as response:
                final = urllib.parse.urlsplit(response.geturl())
                try:
                    final_port = final.port or 443
                except ValueError:
                    final_port = -1
                if (
                    final.scheme != "https"
                    or not final.hostname
                    or final.hostname.casefold() != self.origin_host
                    or final_port != self.origin_port
                    or final.username is not None
                    or final.password is not None
                ):
                    raise HomingError("redirect", "Homing redirected outside its configured origin")
                return Response(
                    response.status, response.read(2_000_001), dict(response.headers.items())
                )
        except urllib.error.HTTPError as exc:
            return Response(exc.code, exc.read(65536), dict(exc.headers.items()))
        except (TimeoutError, socket.timeout) as exc:
            raise HomingError("timeout", "Homing request timed out", retryable=True) from exc
        except urllib.error.URLError as exc:
            if isinstance(exc.reason, (TimeoutError, socket.timeout)):
                raise HomingError("timeout", "Homing request timed out", retryable=True) from exc
            raise HomingError("unavailable", "Homing is unavailable", retryable=True) from exc

    def request(
        self,
        method: str,
        path: str,
        payload: Optional[Dict[str, Any]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Response:
        if not path.startswith("/") or urllib.parse.urlsplit(path).netloc:
            raise ValueError("path must be origin-relative")
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        headers = {"Accept": "application/json", "Authorization": "Bearer " + self.token_provider()}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        response = self.transport(method, self.origin + path, body, headers)
        if response.status == 401:
            raise HomingError("authentication", "Homing rejected this connection")
        if response.status == 403:
            raise HomingError("permission", "This connection lacks permission")
        if response.status == 429:
            raise HomingError("throttled", "Homing asked the runner to retry later", retryable=True)
        if response.status >= 500:
            raise HomingError("unavailable", "Homing is unavailable", retryable=True)
        return response

    @staticmethod
    def _json(response: Response, expected: Tuple[int, ...]) -> Dict[str, Any]:
        if response.status not in expected:
            kind = (
                "conflict"
                if response.status == 409
                else "invalid"
                if response.status == 422
                else "http"
            )
            raise HomingError(kind, "Homing returned HTTP %d" % response.status)
        try:
            value = json.loads(response.body.decode())
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise HomingError("malformed", "Homing returned malformed JSON") from exc
        if not isinstance(value, dict):
            raise HomingError("malformed", "Homing returned a non-object response")
        return value

    def projects(self) -> list[Dict[str, Any]]:
        value = self._json(self.request("GET", "/api/v1/agent/projects"), (200,))
        if value.get("agent_paused_until"):
            raise HomingError("paused", "Homing housing search is paused")
        projects = value.get("items", value.get("projects", value.get("results")))
        if not isinstance(projects, list):
            raise HomingError("malformed", "Project snapshot is missing")
        return projects

    def config_revision(self, project_id: str, revision: str, digest: str) -> Dict[str, Any]:
        response = self.request(
            "GET",
            "/api/v1/projects/%s/config-revisions/%s"
            % (urllib.parse.quote(project_id, safe=""), urllib.parse.quote(str(revision), safe="")),
        )
        if response.status != 200:
            raise HomingError(
                "history_unavailable",
                "Configuration revision is unavailable",
                retryable=response.status >= 500,
            )
        try:
            return parse_verified_json(
                response.body,
                digest,
                response.headers.get("ETag", response.headers.get("Etag", "")),
            )
        except ContractError as exc:
            raise HomingError("hash_mismatch", str(exc)) from exc

    def source_revision(self, project_id: str, revision_id: str, digest: str) -> Dict[str, Any]:
        response = self.request(
            "GET",
            "/api/v1/projects/%s/source-query-revisions/%s"
            % (urllib.parse.quote(project_id, safe=""), urllib.parse.quote(revision_id, safe="")),
        )
        if response.status != 200:
            raise HomingError(
                "history_unavailable",
                "Source-query revision is unavailable",
                retryable=response.status >= 500,
            )
        try:
            return parse_verified_json(
                response.body,
                digest,
                response.headers.get("ETag", response.headers.get("Etag", "")),
            )
        except ContractError as exc:
            raise HomingError("hash_mismatch", str(exc)) from exc

    def create_run(self, invocation_id: str, projects: list[Dict[str, Any]]) -> str:
        value = self._json(
            self.request(
                "POST",
                "/api/v1/agent-runs",
                {"invocation_id": invocation_id, "projects": projects, "phase": "snapshot"},
                invocation_id,
            ),
            (200, 201),
        )
        if not isinstance(value.get("id"), (str, int)):
            raise HomingError("malformed", "Run response has no id")
        return str(value["id"])

    def finish_run(self, server_run_id: str, report: Dict[str, Any]) -> None:
        self._json(
            self.request(
                "PATCH",
                "/api/v1/agent-runs/%s" % urllib.parse.quote(server_run_id, safe=""),
                report,
            ),
            (200,),
        )

    def deliver(self, project_id: str, payload: Dict[str, Any], key: str) -> Dict[str, Any]:
        response = self.request(
            "POST",
            "/api/v1/projects/%s/leads/create-or-return-existing"
            % urllib.parse.quote(project_id, safe=""),
            payload,
            key,
        )
        return self._json(response, (200, 201))

    def create_config(self, project_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self._json(
            self.request(
                "POST",
                "/api/v1/projects/%s/config-revisions" % urllib.parse.quote(project_id, safe=""),
                payload,
            ),
            (201,),
        )

    def finalize_setup(self) -> Dict[str, Any]:
        return self._json(self.request("POST", "/api/v1/me/token/finalize-setup", {}), (200,))

    def connection_id(self) -> str:
        value = self._json(self.request("GET", "/api/v1/me/token"), (200,))
        connection_id = value.get("id")
        if not isinstance(connection_id, str) or not connection_id:
            raise HomingError("malformed", "Connection introspection has no id")
        try:
            return str(uuid.UUID(connection_id))
        except ValueError as exc:
            raise HomingError("malformed", "Connection introspection id is not a UUID") from exc

    def disconnect(self) -> None:
        response = self.request("DELETE", "/api/v1/me/token")
        if response.status not in {200, 204}:
            raise HomingError("http", "Homing returned HTTP %d" % response.status)


class PairingError(RuntimeError):
    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def store_keychain(service: str, account: str, token: str) -> None:
    fields = (service, account, token)
    if any(
        not value
        or any(character.isspace() or character in {'"', "'", "\\"} for character in value)
        for value in fields
    ):
        raise PairingError("keychain_unquotable")
    command = "add-generic-password -U -s %s -a %s -l Homing-API-token -w %s\n" % fields
    try:
        result = subprocess.run(
            ["/usr/bin/security", "-i"],
            input=command.encode("utf-8"),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PairingError("keychain_unavailable") from exc
    if result.returncode:
        raise PairingError("keychain_rejected")
    try:
        check = subprocess.run(
            ["/usr/bin/security", "find-generic-password", "-s", service, "-a", account, "-w"],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise PairingError("keychain_unverified") from exc
    if check.returncode or check.stdout.decode("utf-8", "replace").strip("\r\n") != token:
        raise PairingError("keychain_unverified")


class Pairer:
    def __init__(
        self,
        origin: str,
        transport: Optional[Callable[..., Response]] = None,
        keychain_writer: Callable[[str, str, str], None] = store_keychain,
        sleeper: Callable[[float], None] = time.sleep,
    ):
        self.public = HomingClient(origin, lambda: "", transport=transport)
        self.writer, self.sleeper = keychain_writer, sleeper

    @staticmethod
    def _body(response: Response) -> Dict[str, Any]:
        try:
            value = json.loads(response.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise PairingError("malformed") from exc
        if not isinstance(value, dict):
            raise PairingError("malformed")
        return value

    @staticmethod
    def _error_code(body: Dict[str, Any]) -> str:
        error = body.get("error")
        return str(error.get("code", "")) if isinstance(error, dict) else str(body.get("code", ""))

    def pair(
        self,
        label: str,
        service: str,
        on_code: Callable[[Dict[str, str]], None],
        max_polls: int = 120,
    ) -> Dict[str, str]:
        if not label.strip():
            raise PairingError("invalid_request")
        start = self.public.transport(
            "POST",
            self.public.origin + "/api/v1/agent-link",
            json.dumps(
                {"agent_label": label[:120], "protocol_version": 2}, separators=(",", ":")
            ).encode(),
            {"Accept": "application/json", "Content-Type": "application/json"},
        )
        if start.status != 201:
            raise PairingError(self._error_code(self._body(start)) or "start_failed")
        body = self._body(start)
        device_code, user_code = body.get("device_code"), body.get("user_code")
        verification = body.get("verification_uri_complete") or body.get("verification_uri")
        if not all(
            isinstance(item, str) and item for item in (device_code, user_code, verification)
        ):
            raise PairingError("malformed")
        on_code({"user_code": user_code, "verification_url": verification})
        interval = max(1, int(body.get("interval", 5)))
        for _ in range(max_polls):
            poll = self.public.transport(
                "POST",
                self.public.origin + "/api/v1/agent-link/token",
                json.dumps({"device_code": device_code}, separators=(",", ":")).encode(),
                {"Accept": "application/json", "Content-Type": "application/json"},
            )
            value = self._body(poll)
            if poll.status == 200:
                token, connection_id = value.get("token"), value.get("connection_id")
                if (
                    not isinstance(token, str)
                    or not token
                    or not isinstance(connection_id, str)
                    or not connection_id
                ):
                    raise PairingError("malformed")
                account = connection_id
                self.writer(service, account, token)
                return {"connection_id": connection_id, "service": service, "account": account}
            code = self._error_code(value)
            if code == "authorization_pending":
                self.sleeper(interval)
                continue
            if code == "slow_down":
                interval += 5
                self.sleeper(interval)
                continue
            mapping = {
                "expired_token": "expired",
                "access_denied": "denied",
                "already_used": "used",
                "invalid_request": "invalid",
                "mistyped_code": "invalid",
            }
            raise PairingError(mapping.get(code, code or "poll_failed"))
        raise PairingError("expired")


def _installed_client(
    service: Optional[str] = None,
    account: Optional[str] = None,
    manifest_path: Optional[str] = None,
    connection_id: Optional[str] = None,
) -> tuple[HomingClient, Dict[str, Any]]:
    runtime = Path(__file__).resolve().parent
    try:
        path = (
            Path(manifest_path).resolve()
            if manifest_path
            else runtime.parent / "install-manifest.json"
        )
        manifest = json.loads(path.read_text(encoding="utf-8"))
        keychain = manifest["keychain"]
    except FileNotFoundError:
        if not service or not account:
            raise HomingError(
                "not_installed",
                "Nonsecret Keychain service and account are required before installation",
            )
        manifest = {
            "keychain": {"service": service, "account": account},
            "connection_id": connection_id,
        }
        keychain = manifest["keychain"]
    origin = manifest.get("origin", ORIGIN)
    if origin != ORIGIN:
        raise HomingError("configuration", "manifest origin is not the fixed Homing origin")
    return HomingClient(
        origin, lambda: keychain_token(keychain["service"], keychain["account"])
    ), manifest


def _stdin_object() -> Dict[str, Any]:
    value = json.load(sys.stdin)
    if not isinstance(value, dict):
        raise ValueError("input must be a JSON object")
    return value


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service")
    parser.add_argument("--account")
    sub = parser.add_subparsers(dest="action", required=True)
    sub.add_parser("projects")
    config = sub.add_parser("config")
    config.add_argument("project")
    config.add_argument("revision")
    config.add_argument("digest")
    source = sub.add_parser("source")
    source.add_argument("project")
    source.add_argument("revision")
    source.add_argument("digest")
    sub.add_parser("create-run")
    finish = sub.add_parser("finish-run")
    finish.add_argument("server_run_id")
    deliver = sub.add_parser("deliver")
    deliver.add_argument("project")
    deliver.add_argument("key")
    create_config = sub.add_parser("create-config")
    create_config.add_argument("project")
    sub.add_parser("finalize-setup")
    sub.add_parser("connection-id")
    pair = sub.add_parser("pair")
    pair.add_argument("--label", required=True)
    pair.add_argument("--service", default="com.hartphoenix.homing.v2")
    disconnect = sub.add_parser("disconnect")
    disconnect.add_argument("--connection", required=True)
    disconnect.add_argument("--manifest")
    args = parser.parse_args(argv)
    try:
        if args.action == "pair":
            pairer = Pairer(ORIGIN)
            value = pairer.pair(
                args.label,
                args.service,
                lambda code: print(json.dumps(code, separators=(",", ":")), flush=True),
            )
            print(json.dumps(value, separators=(",", ":")))
            return 0
        client, manifest = _installed_client(
            args.service,
            args.account,
            getattr(args, "manifest", None),
            getattr(args, "connection", None),
        )
        if args.action == "projects":
            value: Any = {"projects": client.projects()}
        elif args.action == "config":
            value = client.config_revision(args.project, args.revision, args.digest)
        elif args.action == "source":
            value = client.source_revision(args.project, args.revision, args.digest)
        elif args.action == "create-run":
            payload = _stdin_object()
            value = {"id": client.create_run(payload["invocation_id"], payload["projects"])}
        elif args.action == "finish-run":
            client.finish_run(args.server_run_id, _stdin_object())
            value = {"status": "acknowledged"}
        elif args.action == "deliver":
            value = client.deliver(args.project, _stdin_object(), args.key)
        elif args.action == "create-config":
            value = client.create_config(args.project, _stdin_object())
        elif args.action == "finalize-setup":
            value = client.finalize_setup()
        elif args.action == "connection-id":
            value = {"connection_id": client.connection_id()}
        else:
            if args.connection != str(manifest.get("connection_id")):
                raise HomingError(
                    "connection", "connection identity does not match this installation"
                )
            if client.connection_id() != args.connection:
                raise HomingError(
                    "connection", "credential identity does not match requested connection"
                )
            client.disconnect()
            value = {"status": "disconnected"}
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError, HomingError) as exc:
        kind = getattr(exc, "kind", "client")
        print(json.dumps({"error": kind}, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
