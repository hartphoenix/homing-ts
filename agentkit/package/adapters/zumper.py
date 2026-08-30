from __future__ import annotations

from typing import Dict, List

from .shared import parse_page

SOURCE = "zumper-com"
ORIGIN = "https://www.zumper.com"
EMPTY = ("no rentals found", "no apartments found", "0 rentals")


def parse(page: str) -> List[Dict[str, object]]:
    return parse_page(page, SOURCE, ORIGIN, EMPTY)
