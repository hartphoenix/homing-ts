from .streeteasy import parse as parse_streeteasy
from .zumper import parse as parse_zumper

ADAPTERS = {"zumper-com": parse_zumper, "streeteasy-com": parse_streeteasy}
