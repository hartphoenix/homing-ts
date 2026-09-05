from __future__ import annotations

import hashlib
import json
import unicodedata
from typing import Any, Dict, Iterable


EVIDENCE_KEYS = ("location", "price", "availability", "housing_type")
MATCHER_FACT_KEYS = (
    "source",
    "listing_id",
    "canonical_url",
    "title",
    "description_excerpt",
    "evidence",
)
MAX_BODY_BYTES = 2_000_000


class ContractError(ValueError):
    pass


def canonical_json(value: Any) -> bytes:
    """Canonical wire v1 for values already checked to contain no floats."""
    _validate_json(value)
    normalized = _normalize(value)
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode(
        "utf-8"
    )


def _normalize(value: Any) -> Any:
    if isinstance(value, str):
        return unicodedata.normalize("NFC", value)
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {_normalize(key): _normalize(item) for key, item in value.items()}
    return value


def _validate_json(value: Any) -> None:
    if isinstance(value, float):
        raise ContractError("canonical JSON does not permit floating-point numbers")
    if value is None or isinstance(value, (str, bool, int)):
        return
    if isinstance(value, list):
        for item in value:
            _validate_json(item)
        return
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ContractError("JSON object keys must be strings")
        for item in value.values():
            _validate_json(item)
        return
    raise ContractError("unsupported JSON value")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_verified_json(body: bytes, expected_hash: str, etag: str = "") -> Dict[str, Any]:
    if len(body) > MAX_BODY_BYTES:
        raise ContractError("response is too large")
    actual = sha256(body)
    expected = expected_hash.removeprefix("sha256-").lower()
    if actual != expected:
        raise ContractError("canonical body hash mismatch")
    if etag and etag != '"sha256-%s"' % actual:
        raise ContractError("canonical body ETag mismatch")
    try:
        parsed = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ContractError("canonical body is not UTF-8 JSON") from exc
    if not isinstance(parsed, dict):
        raise ContractError("canonical body must be a JSON object")
    return parsed


def validate_evidence(evidence: Any) -> Dict[str, Dict[str, Any]]:
    if not isinstance(evidence, dict) or set(evidence) != set(EVIDENCE_KEYS):
        raise ContractError("evidence must contain exactly the v2 evidence registry")
    result: Dict[str, Dict[str, Any]] = {}
    for key in EVIDENCE_KEYS:
        item = evidence[key]
        if not isinstance(item, dict) or item.get("state") not in {"present", "absent", "unknown"}:
            raise ContractError("invalid evidence state for %s" % key)
        allowed = {"state", "value"} if item["state"] == "present" else {"state"}
        if set(item) != allowed or (item["state"] == "present" and item.get("value") is None):
            raise ContractError("invalid evidence shape for %s" % key)
        result[key] = item
    return result


def matcher_projection(observation: Any) -> Dict[str, Any]:
    """Return the one canonical set of facts visible to matching."""
    if not isinstance(observation, dict) or any(
        key not in observation for key in MATCHER_FACT_KEYS
    ):
        raise ContractError("listing observation is missing matcher-visible facts")
    projection = {key: observation[key] for key in MATCHER_FACT_KEYS}
    if any(not isinstance(projection[key], str) for key in MATCHER_FACT_KEYS[:-1]):
        raise ContractError("matcher-visible listing fields must be strings")
    validate_evidence(projection["evidence"])
    return projection


def validate_matcher_projection(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict) or set(value) != set(MATCHER_FACT_KEYS):
        raise ContractError("matcher input must be the exact matcher-visible projection")
    return matcher_projection(value)


def matcher_facts_hash(observation: Any) -> str:
    return sha256(canonical_json(matcher_projection(observation)))


def validate_required(keys: Iterable[str]) -> tuple[str, ...]:
    values = tuple(keys)
    if len(values) != len(set(values)) or any(key not in EVIDENCE_KEYS for key in values):
        raise ContractError("required_evidence contains an unsupported or duplicate key")
    return values
