"""The demo serves the supplied documents, not Markdown placeholders."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from app.connectors.sources.demo import connector as demo


@pytest.mark.asyncio
async def test_bundled_assets_stream_with_their_real_content_and_types() -> None:
    connector = demo.DemoConnector.__new__(demo.DemoConnector)
    connector._fixture = None
    connector._bodies = {}
    connector._files = {}
    connector.connector_id = "demo-1"
    connector.data_entities_processor = SimpleNamespace(org_id="org-1")
    fixture = connector._load_fixture()
    records = {record["id"]: record for record in fixture["records"]}
    containers = {container["id"]: container for container in fixture["containers"]}
    people = {person["id"]: person for person in fixture["people"]}

    assert len(connector._files) == 21
    for record_id, path in connector._files.items():
        record = records[record_id]
        built = connector._build_record(
            record,
            containers[record["container"]],
            people,
            SimpleNamespace(id="group"),
            0,
        )
        response = await connector.stream_record(built)
        content = b"".join([chunk async for chunk in response.body_iterator])
        assert content == path.read_bytes()
        assert response.media_type == demo._ASSET_MIME[path.suffix]
        assert built.mime_type == response.media_type
        assert built.extension == path.suffix[1:]
        assert built.record_name.lower().endswith(path.suffix)
        assert built.version == 0
        assert built.external_revision_id == demo._asset_revision(path)


@pytest.mark.parametrize(
    "name", ["../outside.pdf", "subdir/file.pdf", "file.exe", "missing.pdf"]
)
def test_asset_paths_reject_invalid_or_missing_files(name: str) -> None:
    with pytest.raises(ValueError):
        demo._asset_path(name)


def test_asset_revision_changes_with_contents(tmp_path) -> None:
    asset = tmp_path / "test.pdf"
    asset.write_bytes(b"first")
    original = demo._asset_revision(asset)
    assert original == demo._asset_revision(asset)
    asset.write_bytes(b"second")
    assert original != demo._asset_revision(asset)


@pytest.mark.asyncio
async def test_repeat_sync_keeps_stable_record_ids_and_revisions(monkeypatch) -> None:
    connector = demo.DemoConnector.__new__(demo.DemoConnector)
    connector._fixture = None
    connector._bodies = {}
    connector._files = {}
    connector.connector_id = "demo-1"
    connector.created_by = ""
    connector.logger = Mock()
    processor = connector.data_entities_processor = SimpleNamespace(
        org_id="org-1",
        on_new_app_users=AsyncMock(),
        on_new_user_groups=AsyncMock(),
        on_new_record_groups=AsyncMock(),
        on_new_records=AsyncMock(),
        get_record_by_external_id=AsyncMock(return_value=None),
    )
    monkeypatch.setattr(demo, "_wait_for_members", AsyncMock(return_value=[]))
    await connector.run_sync()
    await connector.run_sync()
    batches = [call.args[0] for call in processor.on_new_records.await_args_list]
    assert len(batches) == 2
    snapshots = [
        {record.external_record_id: record.external_revision_id for record, _ in batch}
        for batch in batches
    ]
    assert snapshots[0] == snapshots[1]
    assert "mobart-001-preventivo-xlsx" in snapshots[0]
