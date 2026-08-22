#!/usr/bin/env python3
"""Closed-state HTTPS fixture for one complete Homing cycle."""

import hashlib
import json
import os
import ssl
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


PROJECT = "11111111-1111-4111-8111-111111111111"
LEAD = "33333333-3333-4333-8333-333333333333"
CLAIM = "fixture-claim-value-not-exported"
state = {"run": "ready", "leads": {}, "requests": 0, "cycles": 0,
         "violations": [], "idempotency": {}, "run_id": ""}
TRANSCRIPT = "/tmp/fixture-transcript.jsonl"
STATE_FILE = "/tmp/fixture-state.json"


def persist():
    public = {key: value for key, value in state.items() if key != "idempotency"}
    temporary = STATE_FILE + ".write"
    with open(temporary, "w", encoding="utf-8") as handle:
        json.dump(public, handle, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, STATE_FILE)


def record(method, host, path, raw, headers, status):
    entry = {
        "sequence": state["requests"], "method": method, "host": host, "path": path,
        "body_sha256": hashlib.sha256(raw).hexdigest(),
        "authorization_present": bool(headers.get("Authorization")),
        "idempotency_sha256": hashlib.sha256(
            headers.get("Idempotency-Key", "").encode()).hexdigest()
            if headers.get("Idempotency-Key") else "",
        "state": state["run"], "status": status,
    }
    with open(TRANSCRIPT, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")
    persist()


class Handler(BaseHTTPRequestHandler):
    server_version = "HomingFixture/1"

    def log_message(self, _format, *_args):
        return

    def body(self):
        length = min(int(self.headers.get("Content-Length", "0")), 1024 * 1024)
        return self.rfile.read(length) if length else b""

    def send_json(self, status, value):
        data = json.dumps(value, sort_keys=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", '"fixture"')
        self.end_headers()
        self.wfile.write(data)
        record(self.command, getattr(self, "request_host", ""),
               getattr(self, "request_path", ""), getattr(self, "request_body", b""),
               self.headers, status)

    def violation(self, message):
        state["violations"].append(message)
        self.send_json(409, {"error": {"code": "fixture_state_violation", "message": message}})

    def require_auth(self):
        return self.headers.get("Authorization") == "Bearer fixture-only-token"

    def do_GET(self):
        state["requests"] += 1
        host = self.headers.get("Host", "").split(":")[0]
        path = urlsplit(self.path).path
        self.request_host, self.request_path, self.request_body = host, path, b""
        if state["requests"] > 300:
            self.violation("request bound exceeded")
            return
        if host == "source.test" and path == "/robots.txt":
            if state["run"] != "project-read":
                self.violation("robots read out of order")
                return
            data = b"User-agent: *\nAllow: /\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            record("GET", host, path, b"", self.headers, 200)
            return
        if host == "source.test" and path == "/listings.xml":
            if state["run"] not in ("project-read", "source-read"):
                self.violation("listing fetched out of order")
                return
            data = (b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
                    b"<url><loc>https://source.test:8443/listing/fixture-one</loc>"
                    b"<lastmod>2026-08-22</lastmod></url></urlset>")
            self.send_response(200)
            self.send_header("Content-Type", "application/xml")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            state["run"] = "source-read"
            record("GET", host, path, b"", self.headers, 200)
            return
        if host == "source.test" and path == "/listing/fixture-one":
            if state["run"] != "source-read":
                self.violation("listing detail fetched out of order")
                return
            data = b"<html><body><h1>Fixture apartment</h1><p>Available now</p></body></html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            record("GET", host, path, b"", self.headers, 200)
            return
        if path == "/health":
            self.send_json(200, {"ok": True})
            return
        if not self.require_auth():
            self.send_json(401, {"error": {"code": "unauthorized", "message": "fixture"}})
            return
        if path == "/api/v1/me/projects":
            if state["run"] == "completed":
                state["run"] = "ready"
            if state["run"] != "ready":
                self.violation("projects read out of order")
                return
            self.send_json(200, {"items": [{"id": PROJECT}], "agent_paused_until": ""})
        elif path == "/api/v1/projects/" + PROJECT:
            if state["run"] not in ("ready", "project-read", "source-read"):
                self.violation("project read out of order")
                return
            if state["run"] != "source-read":
                state["run"] = "project-read"
            self.send_json(200, {"id": PROJECT, "name": "Fixture search",
                                 "prompt": "Find the fixture listing", "prompt_revision": 1})
        elif path == "/api/v1/projects/%s/changes" % PROJECT:
            if state["run"] != "project-read":
                self.violation("changes read out of order")
                return
            self.send_json(200, {"items": [], "next_cursor": "fixture:1"})
        elif path == "/api/v1/projects/%s/leads/%s" % (PROJECT, LEAD):
            if state["run"] not in ("leads-written", "completed"):
                self.violation("lead verification out of order")
                return
            self.send_json(200, state["leads"].get(LEAD, {}))
        else:
            self.violation("unknown GET route: " + path)

    def do_POST(self):
        state["requests"] += 1
        host = self.headers.get("Host", "").split(":")[0]
        path = urlsplit(self.path).path
        raw = self.body()
        self.request_host, self.request_path, self.request_body = host, path, raw
        if state["requests"] > 300:
            self.violation("request bound exceeded")
            return
        if host != "homing.test":
            self.violation("POST used an undeclared host")
            return
        if not self.require_auth():
            self.send_json(401, {"error": {"code": "unauthorized", "message": "fixture"}})
            return
        try:
            payload = json.loads(raw.decode()) if raw else {}
        except ValueError:
            self.send_json(400, {"error": {"code": "invalid_json", "message": "fixture"}})
            return
        idempotency = self.headers.get("Idempotency-Key", "")
        body_digest = hashlib.sha256(raw).hexdigest()
        if idempotency and idempotency in state["idempotency"]:
            previous = state["idempotency"][idempotency]
            if previous[0] != path or previous[1] != body_digest:
                self.violation("idempotency key reused with different request")
                return
            self.send_json(previous[2], previous[3])
            return

        def reply(status, value, require_idempotency=False):
            if require_idempotency and not idempotency:
                self.violation("missing idempotency key for " + path)
                return
            if idempotency:
                state["idempotency"][idempotency] = [path, body_digest, status, value]
            self.send_json(status, value)

        if path == "/api/v1/projects/%s/search-runs" % PROJECT:
            if state["run"] != "source-read":
                self.violation("search run created out of order")
                return
            state["run"] = "run-created"
            state["run_id"] = "22222222-2222-4222-8222-%012d" % (state["cycles"] + 1)
            reply(201, {"id": state["run_id"], "prompt_revision": 1,
                        "prompt_snapshot": "Find the fixture listing"}, True)
        elif path == "/api/v1/projects/%s/search-runs/%s/claim" % (PROJECT, state["run_id"]):
            if state["run"] != "run-created":
                self.violation("search run claimed out of order")
                return
            state["run"] = "claimed"
            reply(200, {"claim_token": CLAIM,
                        "lease_expires_at": "2099-01-01T00:00:00Z"})
        elif path == "/api/v1/projects/%s/leads/bulk-upsert" % PROJECT:
            if state["run"] != "claimed":
                self.violation("lead write out of order")
                return
            items = payload.get("items") or []
            results = []
            for item in items:
                stored = dict(item)
                stored["id"] = LEAD
                state["leads"][LEAD] = stored
                results.append({"outcome": "created", "lead": stored})
            state["run"] = "leads-written"
            reply(200, {"results": results}, True)
        elif path == "/api/v1/projects/%s/search-runs/%s/complete" % (PROJECT, state["run_id"]):
            if state["run"] not in ("claimed", "leads-written"):
                self.violation("completion out of order")
                return
            if payload.get("claim_token") != CLAIM:
                self.send_json(409, {"error": {"code": "lease_lost", "message": "fixture"}})
                return
            state["run"] = "completed"
            state["cycles"] += 1
            reply(200, {"ok": True}, True)
        elif path == "/api/v1/projects/%s/search-runs/%s/heartbeat" % (
                PROJECT, state["run_id"]):
            if state["run"] != "claimed":
                self.violation("heartbeat out of order")
                return
            reply(200, {"lease_expires_at": "2099-01-01T00:00:00Z"})
        else:
            self.violation("unknown POST route: " + path)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", 8443), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain("/opt/fixture/server-cert.pem", "/opt/fixture/server-key.pem")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
