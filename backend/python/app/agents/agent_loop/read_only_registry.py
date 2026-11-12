"""A scheduled research turn may only retrieve scoped knowledge and answer."""

import hashlib
import json
import math
from typing import Any

from app.agent_loop_lib.tools.registry import ToolRegistry

_ALLOWED_PATHS = frozenset({
    "/tools/retrieval/search_internal_knowledge",
    "/toolsets/builtin/final_answer",
})


def _canonical(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _canonical(value[key]) for key in sorted(value, key=lambda s: s.encode("utf-16be", "surrogatepass"))}
    if isinstance(value, list):
        return [_canonical(item) for item in value]
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    return value


def matches_approved_model(config: Any, model_key: str | None, model_name: str | None, fingerprint: str | None) -> bool:
    if not isinstance(config, dict) or not model_key or not model_name or not fingerprint:
        return False
    configuration = config.get("configuration")
    if not isinstance(configuration, dict):
        return False
    names = configuration.get("model", "")
    if not isinstance(names, str) or model_name not in [name.strip() for name in names.split(",")]:
        return False
    if config.get("modelKey") != model_key:
        return False
    try:
        encoded = json.dumps(_canonical(config), ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError):
        return False
    return hashlib.sha256(encoded).hexdigest() == fingerprint


class ReadOnlyRetrievalRegistry(ToolRegistry):
    """Enforce the allowlist even for tools registered after initial loading."""

    def register_tool(self, tool: Any, *, extra_tags: tuple = ()) -> None:
        if tool.path in _ALLOWED_PATHS:
            super().register_tool(tool, extra_tags=extra_tags)

    def register_toolset_provider(self, provider: Any) -> None:
        # Lazy providers can materialize unreviewed tools after the first model turn.
        return None
