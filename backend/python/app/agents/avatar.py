"""Agent pictures are owned assets or authenticated, agent-scoped uploads."""

import re


def parse_avatar_url(value: object, agent_id: str | None = None) -> str | None:
    if value is None:
        return None
    if isinstance(value, str) and len(value) <= 200:
        if re.fullmatch(r"/assets/agents/[a-z0-9][a-z0-9._-]*\.(?:png|webp|jpg)", value):
            return value
        uploaded = re.fullmatch(r"/api/v1/agents/([0-9a-f-]{36})/avatar/[0-9a-f-]{36}", value)
        if uploaded and uploaded.group(1) == agent_id:
            return value
    raise ValueError("Agent picture must name an owned asset or this agent's uploaded picture")
