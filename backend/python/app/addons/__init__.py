"""Installed search add-ons use the host's identity and provider dependencies."""
from importlib import import_module

SEARCH_ADDONS = ("knowledge_graph",)


def register_search_addons(router, *, identity, provider) -> None:
    for addon in SEARCH_ADDONS:
        create_router = import_module(f"app.addons.{addon}.router").create_router
        router.include_router(create_router(identity=identity, provider=provider))
