"""Huddle notes through the real Slack connector and a synthetic Slack API."""

import time

import pytest
from slack_behaviour_setup import (
    ALICE,
    BOB,
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


@pytest.mark.parametrize("personal", [False, True])
async def test_huddle_mentions_are_readable_unique_and_never_permission_grants(workspace, store, checkpoints, personal, monkeypatch) -> None:
    factory = personal_connector if personal else workspace_connector
    next(user for user in workspace.users if user["id"] == ALICE)["profile"]["real_name"] = "Mohamed Gaafer"
    connector, _ = await factory(store, checkpoints)
    await connector.run_sync()
    key = huddle_id(GENERAL, "FHUDDLE")
    before = store.records[key]
    grants = [(p.entity_type, p.external_id, p.email, p.type) for p in store.record_permissions[key]]
    original_info = workspace._api_users_info
    outsider_info = {"ok": True, "user": {
        "id": "U0OUTSIDER", "profile": {"real_name": "Mohamed Other", "email": "other.mohamed@acme.com"},
    }}
    monkeypatch.setattr(workspace, "_api_users_info", lambda params: (
        outsider_info if params.get("user") == "U0OUTSIDER" else original_info(params)
    ))
    workspace.canvases["FHUDDLE"] = (
        f"# :handshake: Attendees\n\n<@{ALICE}> and &lt;@{BOB}&gt; met <@U0OUTSIDER|wrong label>.\n"
        "## :star: Summary\n\n:white_check_mark: Done :custom_exodia: :thumbsup::skin-tone-3:\n"
        f"`<@{ALICE}> :star:`\n\n```\n<@{BOB}> :star:\n```\n"
        "\n[Original link](https://example.test/:star:)\n"
    )
    await connector.run_sync()
    record = store.records[key]
    assert record.id == before.id
    assert record.external_revision_id != before.external_revision_id
    connector.user_id_to_name_cache.clear()
    connector.user_id_to_email_cache.clear()
    rendered = (await body(await connector.stream_record(record))).decode()
    assert "[@Mohamed Gaafer](https://acme.slack.com/team/U0ALICE)" in rendered
    assert "Slack ID: U0ALICE; Email: alice@acme.com" in rendered
    assert "[@Bob](https://acme.slack.com/team/U0BOB)" in rendered
    assert "[@Mohamed Other](https://acme.slack.com/team/U0OUTSIDER)" in rendered
    assert "Slack ID: U0OUTSIDER; Email: other.mohamed@acme.com" in rendered
    assert "wrong label" not in rendered
    assert "## ⭐ Summary" in rendered
    assert "✅ Done :custom_exodia:" in rendered
    assert "👍🏼" in rendered
    assert f"`<@{ALICE}> :star:`" in rendered
    assert f"```\n<@{BOB}> :star:\n```" in rendered
    assert "[Original link](https://example.test/:star:)" in rendered
    assert [(p.entity_type, p.external_id, p.email, p.type) for p in store.record_permissions[key]] == grants
    assert not any(u.source_user_id == "U0OUTSIDER" for u in store.app_users.values())
