from __future__ import annotations

import html
import json
import re
import urllib.parse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Any, Dict, Iterable, Iterator, Optional

from ..common import matcher_facts_hash, validate_evidence


SCRIPT_JSON = re.compile(
    r'<script[^>]+type=["\']application/(?:ld\+)?json["\'][^>]*>(.*?)</script>', re.I | re.S
)
NEXT_JSON = re.compile(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', re.I | re.S)


class AdapterFormatError(ValueError):
    pass


def json_documents(page: str) -> Iterator[Any]:
    for match in list(SCRIPT_JSON.finditer(page)) + list(NEXT_JSON.finditer(page)):
        try:
            yield json.loads(html.unescape(match.group(1)).strip())
        except json.JSONDecodeError:
            continue


def walk(value: Any) -> Iterator[Dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)


def first(mapping: Dict[str, Any], *paths: str) -> Any:
    for path in paths:
        current: Any = mapping
        for part in path.split("."):
            if not isinstance(current, dict) or part not in current:
                current = None
                break
            current = current[part]
        if current not in (None, ""):
            return current
    return None


def price_minor(raw: Any) -> Optional[int]:
    if isinstance(raw, bool) or not isinstance(raw, (int, float, str)):
        return None
    match = re.search(r"-?\d[\d,]*(?:\.\d+)?", str(raw))
    if not match:
        return None
    try:
        amount = Decimal(match.group(0).replace(",", ""))
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount < 0:
        return None
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def location(raw: Any) -> Optional[str]:
    if isinstance(raw, str) and raw.strip():
        return " ".join(raw.split())
    if isinstance(raw, dict):
        parts = [
            raw.get(key)
            for key in ("streetAddress", "addressLocality", "addressRegion", "postalCode")
        ]
        joined = ", ".join(str(part).strip() for part in parts if part)
        return joined or None
    return None


def housing_type(raw: Any) -> Optional[str]:
    if isinstance(raw, list):
        for item in raw:
            normalized = housing_type(item)
            if normalized:
                return normalized
        return None
    if not isinstance(raw, str):
        return None
    value = raw.casefold()
    if any(word in value for word in ("room", "shared", "roommate")):
        return "shared"
    if any(
        word in value for word in ("apartment", "house", "home", "condo", "studio", "residence")
    ):
        return "entire"
    return None


def stable_id(node: Dict[str, Any], url: str) -> Optional[str]:
    raw = first(node, "source_listing_id", "listing_id", "listingId", "id", "@id", "sku")
    if raw:
        return str(raw).strip().rstrip("/").rsplit("/", 1)[-1]
    path = urllib.parse.urlsplit(url).path.rstrip("/")
    match = re.search(r"(?:listing|apartments?|rental)/([^/]+)$", path, re.I)
    return match.group(1) if match else None


def node_to_observation(node: Dict[str, Any], source: str, origin: str) -> Optional[Dict[str, Any]]:
    raw_url = first(node, "url", "canonical_url")
    if not isinstance(raw_url, str):
        return None
    url = urllib.parse.urljoin(origin + "/", raw_url)
    if (
        urllib.parse.urlsplit(url).netloc.casefold()
        != urllib.parse.urlsplit(origin).netloc.casefold()
    ):
        return None
    listing_id = stable_id(node, url)
    title = str(first(node, "name", "title") or "").strip()[:500]
    if not listing_id or not title:
        return None
    raw_price = first(node, "price", "priceRange", "offers.price", "offers.lowPrice")
    raw_location = first(node, "address", "location", "neighborhood")
    raw_availability = first(
        node, "availability", "offers.availability", "availableAtOrFrom.startDate"
    )
    raw_type = first(node, "housing_type", "propertyType", "@type")
    evidence = {
        "location": {"state": "present", "value": location(raw_location)}
        if location(raw_location)
        else {"state": "unknown"},
        "price": {"state": "present", "value": price_minor(raw_price)}
        if price_minor(raw_price) is not None
        else {"state": "unknown"},
        "availability": {"state": "present", "value": str(raw_availability)}
        if raw_availability
        else {"state": "unknown"},
        "housing_type": {"state": "present", "value": housing_type(raw_type)}
        if housing_type(raw_type)
        else {"state": "unknown"},
    }
    for key in ("location", "price", "availability", "housing_type"):
        explicit = node.get("%s_absent" % key)
        if explicit is True:
            evidence[key] = {"state": "absent"}
    validate_evidence(evidence)
    observation = {
        "source": source,
        "listing_id": listing_id,
        "canonical_url": url,
        "title": title,
        "description_excerpt": str(first(node, "description") or "")[:2000],
        "evidence": evidence,
    }
    observation["facts_hash"] = matcher_facts_hash(observation)
    observation["observed_at"] = datetime.now(timezone.utc).isoformat()
    return observation


def parse_page(
    page: str, source: str, origin: str, empty_markers: Iterable[str]
) -> list[Dict[str, Any]]:
    observations: Dict[str, Dict[str, Any]] = {}
    documents = list(json_documents(page))
    for document in documents:
        for node in walk(document):
            observation = node_to_observation(node, source, origin)
            if observation:
                observations[observation["listing_id"]] = observation
    if observations:
        return list(observations.values())
    lowered = " ".join(re.sub(r"<[^>]*>", " ", page).casefold().split())
    if any(marker.casefold() in lowered for marker in empty_markers):
        return []
    raise AdapterFormatError(
        "source page contained neither valid listings nor a recognized empty result"
    )
