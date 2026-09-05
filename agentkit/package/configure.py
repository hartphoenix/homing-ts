from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlsplit

try:
    from .common import ContractError, EVIDENCE_KEYS, validate_required
except ImportError:
    from common import ContractError, EVIDENCE_KEYS, validate_required


CONFIGURE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["acquisition_basis", "required_evidence", "source_queries"],
    "properties": {
        "acquisition_basis": {
            "type": "object",
            "additionalProperties": False,
            "required": ["locations", "min_price_minor", "max_price_minor", "housing_types"],
            "properties": {
                "locations": {
                    "type": "array",
                    "items": {"type": "string", "minLength": 1},
                    "uniqueItems": True,
                },
                "min_price_minor": {"type": ["integer", "null"]},
                "max_price_minor": {"type": ["integer", "null"]},
                "housing_types": {
                    "type": "array",
                    "items": {"enum": ["entire", "shared"]},
                    "uniqueItems": True,
                },
            },
        },
        "required_evidence": {
            "type": "array",
            "items": {"enum": list(EVIDENCE_KEYS)},
            "uniqueItems": True,
        },
        "source_queries": {
            "type": "array",
            "maxItems": 8,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["adapter", "query"],
                "properties": {
                    "adapter": {"enum": ["zumper-com", "streeteasy-com"]},
                    "query": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": ["url"],
                        "properties": {"url": {"type": "string", "format": "uri"}},
                    },
                },
            },
        },
    },
}


def validate_configuration(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "acquisition_basis",
        "required_evidence",
        "source_queries",
    }:
        raise ContractError("configuration output has unexpected fields")
    basis = value["acquisition_basis"]
    if (
        not isinstance(basis, dict)
        or set(basis) != {"locations", "min_price_minor", "max_price_minor", "housing_types"}
        or not isinstance(value["source_queries"], list)
    ):
        raise ContractError("configuration output has invalid fields")
    if (
        not isinstance(basis["locations"], list)
        or not basis["locations"]
        or any(not isinstance(item, str) or not item.strip() for item in basis["locations"])
        or len(set(basis["locations"])) != len(basis["locations"])
    ):
        raise ContractError("configuration requires distinct nonempty locations")
    if any(
        basis[key] is not None
        and (not isinstance(basis[key], int) or isinstance(basis[key], bool) or basis[key] < 0)
        for key in ("min_price_minor", "max_price_minor")
    ):
        raise ContractError("configuration price bounds must be nonnegative integer minor units")
    if (
        basis["min_price_minor"] is not None
        and basis["max_price_minor"] is not None
        and basis["min_price_minor"] > basis["max_price_minor"]
    ):
        raise ContractError("configuration price range is inverted")
    if not isinstance(basis["housing_types"], list) or any(
        item not in {"entire", "shared"} for item in basis["housing_types"]
    ):
        raise ContractError("configuration housing types are invalid")
    validate_required(value["required_evidence"])
    if len(value["source_queries"]) > 8:
        raise ContractError("configuration proposes more than eight queries")
    per_adapter: Dict[str, int] = {}
    identities = set()
    for item in value["source_queries"]:
        if (
            not isinstance(item, dict)
            or set(item) != {"adapter", "query"}
            or item["adapter"] not in {"zumper-com", "streeteasy-com"}
            or not isinstance(item["query"], dict)
        ):
            raise ContractError("configuration proposes an unsupported source query")
        query = item["query"]
        parsed = urlsplit(query.get("url", "") if isinstance(query, dict) else "")
        allowed_hosts = {
            "zumper-com": {"zumper.com", "www.zumper.com"},
            "streeteasy-com": {"streeteasy.com", "www.streeteasy.com"},
        }
        if (
            set(query) != {"url"}
            or parsed.scheme != "https"
            or parsed.hostname not in allowed_hosts[item["adapter"]]
            or parsed.username
            or parsed.password
            or parsed.fragment
        ):
            raise ContractError("configuration proposes a source URL outside its adapter")
        per_adapter[item["adapter"]] = per_adapter.get(item["adapter"], 0) + 1
        if per_adapter[item["adapter"]] > 4:
            raise ContractError("configuration proposes more than four queries for one adapter")
        identity = (
            item["adapter"],
            json.dumps(item["query"], sort_keys=True, separators=(",", ":")),
        )
        if identity in identities:
            raise ContractError("configuration proposes a duplicate query")
        identities.add(identity)
    return value


class ClaudeConfigurator:
    """One attended, tool-disabled prompt translation. It does not save the result."""

    def __init__(
        self,
        executable: str = "claude",
        model: str = "claude-sonnet-4-5",
        budget_usd: str = "0.25",
        timeout: int = 120,
        invoke: Optional[Callable[..., subprocess.CompletedProcess[str]]] = None,
    ):
        self.executable, self.model, self.budget_usd, self.timeout = (
            executable,
            model,
            budget_usd,
            timeout,
        )
        self.invoke = invoke or subprocess.run

    def configure(self, prompt: str) -> Dict[str, Any]:
        if not isinstance(prompt, str) or not prompt.strip():
            raise ContractError("a prompt is required")
        request = {
            "task": "Translate this housing request into the closed Homing v2 configuration schema.",
            "prompt": prompt,
            "supported_adapters": ["zumper-com", "streeteasy-com"],
            "required_evidence_registry": list(EVIDENCE_KEYS),
        }
        with tempfile.TemporaryDirectory(prefix="homing-configure-") as work:
            mcp = Path(work) / "mcp.json"
            settings = Path(work) / "settings.json"
            mcp.write_text('{"mcpServers":{}}', encoding="utf-8")
            settings.write_text("{}", encoding="utf-8")
            command = [
                self.executable,
                "-p",
                "--safe-mode",
                "--tools",
                "",
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--mcp-config",
                str(mcp),
                "--no-session-persistence",
                "--output-format",
                "json",
                "--json-schema",
                json.dumps(CONFIGURE_SCHEMA, separators=(",", ":")),
                "--model",
                self.model,
                "--max-budget-usd",
                self.budget_usd,
                "--settings",
                str(settings),
                "--setting-sources",
                "",
            ]
            env = {
                key: value
                for key, value in os.environ.items()
                if key in {"PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE"}
            }
            try:
                result = self.invoke(
                    command,
                    input=json.dumps(request, separators=(",", ":")),
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=work,
                    env=env,
                    timeout=self.timeout,
                    check=False,
                )
            except (subprocess.TimeoutExpired, OSError) as exc:
                raise RuntimeError("configuration_model_unavailable") from exc
        if result.returncode:
            raise RuntimeError("configuration_model_failed")
        try:
            outer = json.loads(result.stdout)
            value = outer.get("structured_output", outer) if isinstance(outer, dict) else outer
            return validate_configuration(value)
        except json.JSONDecodeError as exc:
            raise RuntimeError("configuration_model_malformed") from exc


def main(argv: Optional[list[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--claude-executable", default="claude")
    args = parser.parse_args(argv)
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or set(request) != {"prompt"}:
            raise ContractError("input must contain only prompt")
        value = ClaudeConfigurator(executable=args.claude_executable).configure(request["prompt"])
        print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        return 0
    except (json.JSONDecodeError, ContractError, RuntimeError, KeyError) as exc:
        print(json.dumps({"error": str(exc)[:80]}, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
