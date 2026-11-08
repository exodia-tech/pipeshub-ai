from pathlib import Path

import yaml


def test_exodia_reader_is_token_protected_and_separate_from_databases() -> None:
    root = Path(__file__).resolve().parents[5]
    compose = yaml.safe_load(
        (root / "deployment/docker-compose/docker-compose.exodia.yml").read_text()
    )
    services = compose["services"]
    app = services["pipeshub-ai"]
    gateway = services["web-readers-gateway"]
    reader = services["crawl4ai"]
    assert "web-gateway" in app["networks"]
    assert set(gateway["networks"]) == {"web-gateway", "web-readers"}
    assert set(reader["networks"]) == {"web-readers"}
    assert "ports" not in reader and "ports" not in gateway
    assert "CRAWL4AI_API_TOKEN=${CRAWL4AI_API_TOKEN:-}" in reader["environment"]
    assert "test -n" in " ".join(reader["command"])
    assert "@sha256:" in reader["image"]
    for database in ("mongodb", "redis", "qdrant", "neo4j"):
        assert "web-readers" not in services[database]["networks"]
