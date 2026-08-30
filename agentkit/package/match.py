from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

try:
    from .common import ContractError, validate_matcher_projection, validate_required
except ImportError:
    from common import ContractError, validate_matcher_projection, validate_required


MATCH_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["disposition", "reason", "unknowns"],
    "properties": {
        "disposition": {"enum": ["kept", "rejected"]},
        "reason": {"type": "string", "minLength": 1, "maxLength": 300},
        "unknowns": {
            "type": "array",
            "items": {"enum": list(("location", "price", "availability", "housing_type"))},
            "uniqueItems": True,
        },
    },
}


@dataclass(frozen=True)
class MatchResult:
    disposition: str
    reason: str
    unknowns: tuple[str, ...] = ()


def deterministic_match(
    observation: Dict[str, Any], config: Dict[str, Any]
) -> Optional[MatchResult]:
    observation = validate_matcher_projection(observation)
    evidence = observation["evidence"]
    required = validate_required(config.get("required_evidence", []))
    absent = [key for key in required if evidence[key]["state"] == "absent"]
    if absent:
        return MatchResult(
            "rejected",
            "Required evidence is explicitly absent: " + ", ".join(absent),
            tuple(absent),
        )
    unknown = [key for key in required if evidence[key]["state"] == "unknown"]
    if unknown:
        return MatchResult(
            "insufficient", "Required evidence is unknown: " + ", ".join(unknown), tuple(unknown)
        )
    basis = config.get("acquisition_basis") or {}
    price = evidence["price"]
    if price["state"] == "present":
        value = price["value"]
        if not isinstance(value, int):
            raise ContractError("price evidence must use integer minor units")
        if basis.get("min_price_minor") is not None and value < basis["min_price_minor"]:
            return MatchResult("rejected", "Price is below the configured range")
        if basis.get("max_price_minor") is not None and value > basis["max_price_minor"]:
            return MatchResult("rejected", "Price is above the configured range")
    housing = evidence["housing_type"]
    configured_housing = basis.get("housing_types")
    if configured_housing and housing["state"] == "present":
        if housing["value"] not in configured_housing:
            return MatchResult("rejected", "Housing type is outside the configured set")
    if not config.get("model_required", bool(config.get("prompt"))):
        return MatchResult("kept", "All deterministic requirements match")
    return None


def validate_model_result(value: Any) -> MatchResult:
    if not isinstance(value, dict) or set(value) != {"disposition", "reason", "unknowns"}:
        raise ContractError("model result has unexpected fields")
    if value["disposition"] not in {"kept", "rejected"}:
        raise ContractError("model disposition is invalid")
    if not isinstance(value["reason"], str) or not (1 <= len(value["reason"]) <= 300):
        raise ContractError("model reason is invalid")
    unknowns = validate_required(
        value["unknowns"] if isinstance(value["unknowns"], list) else ["invalid"]
    )
    return MatchResult(value["disposition"], value["reason"], unknowns)


class ClaudeMatcher:
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

    def match(self, observation: Dict[str, Any], config: Dict[str, Any]) -> MatchResult:
        deterministic = deterministic_match(observation, config)
        if deterministic:
            return deterministic
        request = {
            "task": "Judge this listing only against the supplied housing request.",
            "prompt": config["prompt"],
            "criteria": config.get("criteria", {}),
            "listing": observation,
        }
        with tempfile.TemporaryDirectory(prefix="homing-match-") as work:
            empty_mcp = os.path.join(work, "mcp.json")
            settings = os.path.join(work, "settings.json")
            for path, content in ((empty_mcp, '{"mcpServers":{}}'), (settings, "{}")):
                with open(path, "w", encoding="utf-8") as handle:
                    handle.write(content)
            command = [
                self.executable,
                "-p",
                "--safe-mode",
                "--tools",
                "",
                "--disable-slash-commands",
                "--strict-mcp-config",
                "--mcp-config",
                empty_mcp,
                "--no-session-persistence",
                "--output-format",
                "json",
                "--json-schema",
                json.dumps(MATCH_SCHEMA, separators=(",", ":")),
                "--model",
                self.model,
                "--max-budget-usd",
                self.budget_usd,
                "--settings",
                settings,
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
                raise RuntimeError("model_unavailable") from exc
        if result.returncode:
            raise RuntimeError("model_failed")
        try:
            outer = json.loads(result.stdout)
            structured = outer.get("structured_output", outer) if isinstance(outer, dict) else outer
            return validate_model_result(structured)
        except (json.JSONDecodeError, ContractError) as exc:
            raise RuntimeError("model_malformed") from exc


def main(argv: Optional[list[str]] = None) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--claude-executable", default="claude")
    args = parser.parse_args(argv)
    try:
        value = json.load(sys.stdin)
        if not isinstance(value, dict) or set(value) != {"observation", "config"}:
            raise ContractError("match input has unexpected fields")
        result = ClaudeMatcher(executable=args.claude_executable).match(
            value["observation"], value["config"]
        )
        print(
            json.dumps(
                {
                    "disposition": result.disposition,
                    "reason": result.reason,
                    "unknowns": list(result.unknowns),
                },
                separators=(",", ":"),
            )
        )
        return 0
    except (json.JSONDecodeError, ContractError, RuntimeError, KeyError) as exc:
        print(json.dumps({"error": str(exc)[:80]}, separators=(",", ":")), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
