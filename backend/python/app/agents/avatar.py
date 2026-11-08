"""Agent portraits are deployment-owned assets, not external tracking URLs."""

import re


def parse_avatar_url(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 200 or not re.fullmatch(
        r"/assets/agents/[a-z0-9][a-z0-9._-]*\.(?:png|webp|jpg)", value
    ):
        raise ValueError("Agent avatar must name an approved local image asset")
    return value
