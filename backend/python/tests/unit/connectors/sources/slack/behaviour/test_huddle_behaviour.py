"""Huddle notes through the real Slack connector and a synthetic Slack API."""

import time

import pytest
from slack_behaviour_setup import (
    ALICE,
    GENERAL,
    SECRET,
    personal_connector,
    standard_workspace,
    workspace_connector,
)

from app.connectors.sources.slack.common.huddle import huddle_id
from app.models.entities import ProgressStatus
from app.models.permission import EntityType


@pytest.fixture
def workspace(slack) -> object:
    standard_workspace(slack)
    slack.auth_user_id = ALICE
    slack.files["FHUDDLE"] = {
        "id": "FHUDDLE", "title": "Weekly notes", "filetype": "canvas",
        "is_huddle_canvas": True, "created": int(time.time()) - 60,
        "channels": [GENERAL], "groups": [SECRET], "ims": [],
        "permalink": "https://acme.slack.com/docs/FHUDDLE",
    }
    slack.canvases["FHUDDLE"] = "# Summary\n\nSynthetic notes."
    return slack


async def body(response) -> bytes:
    return b"".join([chunk async for chunk in response.body_iterator])


async def test_company_syncs_each_channel_and_revokes_only_the_removed_share(workspace, store, checkpoints) -> None:
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    public = huddle_id(GENERAL, "FHUDDLE")
    private = huddle_id(SECRET, "FHUDDLE")
    assert {public, private} <= set(store.records)
    assert any(p.entity_type == EntityType.ROLE and p.external_id == "workspace_member" for p in store.record_permissions[public])
    assert {p.email for p in store.record_permissions[private]} == {"alice@acme.com", "bob@acme.com"}
    assert await body(await connector.stream_record(store.records[private])) == b"# Summary\n\nSynthetic notes."
    before = store.records[private].external_revision_id
    workspace.canvases["FHUDDLE"] = "# Updated\n\nSynthetic edit."
    workspace.files["FHUDDLE"]["channels"] = []
    await connector.run_sync()
    assert store.record_permissions[public] == []
    assert store.record_permissions[private]
    assert store.records[private].external_revision_id != before
    assert not workspace.calls_to("conversations.join")


async def test_removed_bot_from_channel_does_not_rejoin_and_revokes_notes(workspace, store, checkpoints) -> None:
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    public = huddle_id(GENERAL, "FHUDDLE")
    workspace.channels[GENERAL]["is_member"] = False
    await connector.run_sync()
    assert not workspace.calls_to("conversations.join")
    assert store.record_permissions[public] == []


async def test_personal_huddle_notes_inherit_only_personal_app_gate(workspace, store, checkpoints) -> None:
    connector, _ = await personal_connector(store, checkpoints)
    await connector.run_sync()
    record = store.records[huddle_id(SECRET, "FHUDDLE")]
    assert record.record_group_id == store.record_groups[SECRET].id
    assert record.external_record_group_id == SECRET
    assert store.record_permissions[record.external_record_id] == []
    assert [u.email for u in store.app_users.values()] == ["alice@acme.com"]
    assert record.indexing_status != ProgressStatus.AUTO_INDEX_OFF.value
    assert await body(await connector.stream_record(record)) == b"# Summary\n\nSynthetic notes."


@pytest.mark.parametrize("personal", [False, True])
async def test_huddle_title_decodes_slack_markup_without_changing_identity_or_grants(workspace, store, checkpoints, personal) -> None:
    factory = personal_connector if personal else workspace_connector
    connector, _ = await factory(store, checkpoints)
    workspace.canvases["FHUDDLE"] = "Notes without a heading."
    await connector.run_sync()
    key = huddle_id(GENERAL, "FHUDDLE")
    before = store.records[key]
    permissions = [(p.entity_type, p.external_id, p.email, p.type) for p in store.record_permissions[key]]
    workspace.files["FHUDDLE"]["title"] = ":headphones: Huddle &amp; notes in &lt;#C0GENERAL&gt;"
    await connector.run_sync()
    after = store.records[key]
    assert after.record_name == "\U0001f3a7 Huddle & notes in #general.md"
    assert after.id == before.id
    assert after.external_revision_id == before.external_revision_id
    assert [(p.entity_type, p.external_id, p.email, p.type) for p in store.record_permissions[key]] == permissions


@pytest.mark.parametrize("personal", [False, True])
async def test_huddle_filename_uses_content_title_inside_channel(workspace, store, checkpoints, personal) -> None:
    factory = personal_connector if personal else workspace_connector
    connector, _ = await factory(store, checkpoints)
    workspace.canvases["FHUDDLE"] = "```\n# Not the title\n```\n\n# **Roadmap** &amp; `planning`\n\nNotes."
    await connector.run_sync()
    record = store.records[huddle_id(GENERAL, "FHUDDLE")]
    assert record.record_name == "Roadmap & planning.md"
    assert record.record_group_id == store.record_groups[GENERAL].id
    assert record.external_record_group_id == GENERAL
    assert not record.inherit_permissions
    assert not store.record_groups[GENERAL].hide_children
    workspace.canvases["FHUDDLE"] = "# Revised title\n\nNotes."
    await connector.run_sync()
    updated = store.records[record.external_record_id]
    assert updated.id == record.id
    assert updated.record_name == "Revised title.md"
