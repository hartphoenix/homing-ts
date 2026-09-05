from __future__ import annotations

from typing import Dict, List

from .shared import parse_page

SOURCE = "streeteasy-com"
ORIGIN = "https://streeteasy.com"
EMPTY = ("no matching listings", "no rentals found", "0 listings")


def parse(page: str) -> List[Dict[str, object]]:
    return parse_page(page, SOURCE, ORIGIN, EMPTY)
