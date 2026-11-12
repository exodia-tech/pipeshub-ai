"""Voice notes through both real connectors, with synthetic Slack and STT."""

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from slack_behaviour_setup import (
    ALICE,
    GENERAL,
    SECRET,
    personal_connector,
    standard_workspace,
    workspace_connector,
)

from app.connectors.sources.slack.common import voice
from app.models.entities import ProgressStatus


@pytest.fixture
def workspace(slack) -> object:
    standard_workspace(slack)
    slack.auth_user_id = ALICE
    slack.files["FVOICE"] = {
        "id": "FVOICE", "name": "voice.m4a", "title": "Voice note", "mimetype": "audio/mp4",
        "filetype": "m4a", "mode": "hosted", "created": int(time.time()) - 60,
        "channels": [GENERAL], "groups": [SECRET], "ims": [],
        "shares": {"public": {GENERAL: [{"ts": "1700000000.000001"}]},
                   "private": {SECRET: [{"ts": "1700000001.000002", "thread_ts": "1700000000.000001"}]}},
        "transcription": {"status": "complete", "preview": {"content": "A synthetic voice note.", "has_more": False}},
        "url_private": "https://files.slack.com/voice.m4a", "size": 12,
    }
    return slack


async def content(connector, record) -> str:
    response = await connector.stream_record(record)
    return b"".join([chunk async for chunk in response.body_iterator]).decode()


async def test_company_channel_folders_separate_grants_and_message_links(workspace, store, checkpoints, monkeypatch) -> None:
    stt = AsyncMock(side_effect=AssertionError("A native transcript must not call STT"))
    monkeypatch.setattr(voice, "get_stt_model_instance", stt)
    workspace.files["FVOICE"]["title"] = ":microphone: Voice &amp; note"
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    public = store.records[voice.voice_id(GENERAL, "FVOICE")]
    private = store.records[voice.voice_id(SECRET, "FVOICE")]
    assert public.record_group_id == store.record_groups[GENERAL].id
    assert public.record_name == "🎤 Voice & note — transcript.md"
    assert private.record_group_id == store.record_groups[SECRET].id
    assert not private.inherit_permissions and not public.inherit_permissions
    assert {p.email for p in store.record_permissions[private.external_record_id]} == {"alice@acme.com", "bob@acme.com"}
    assert "workspace_member" in {p.external_id for p in store.record_permissions[public.external_record_id]}
    assert "/archives/" + SECRET + "/p1700000001000002?thread_ts=" in private.weburl
    text = await content(connector, private)
    assert "A synthetic voice note." in text and "Transcript source: Slack transcript" in text
    assert SECRET in text and "1700000001.000002" in text and "FVOICE" in text
    assert "FVOICE" not in store.records
    stt.assert_not_awaited()
    assert not workspace.calls_to("conversations.join")


async def test_unshare_blocks_stream_and_revokes_only_that_channel(workspace, store, checkpoints) -> None:
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    public = store.records[voice.voice_id(GENERAL, "FVOICE")]
    workspace.files["FVOICE"]["channels"] = []
    workspace.files["FVOICE"]["shares"]["public"] = {}
    with pytest.raises(HTTPException) as error:
        await content(connector, public)
    assert error.value.status_code == 403
    await connector.run_sync()
    assert store.record_permissions[public.external_record_id] == []
    assert store.record_permissions[voice.voice_id(SECRET, "FVOICE")]


async def test_bot_removed_from_channel_revokes_without_rejoining(workspace, store, checkpoints) -> None:
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    workspace.channels[GENERAL]["is_member"] = False
    await connector.run_sync()
    assert store.record_permissions[voice.voice_id(GENERAL, "FVOICE")] == []
    assert not workspace.calls_to("conversations.join")


async def test_personal_owner_gate_and_confirmed_deletion(workspace, store, checkpoints) -> None:
    connector, _ = await personal_connector(store, checkpoints)
    await connector.run_sync()
    key = voice.voice_id(SECRET, "FVOICE")
    assert store.record_permissions[key] == []
    assert not store.records[key].inherit_permissions
    assert set(store.app_users) == {ALICE}
    assert "A synthetic voice note." in await content(connector, store.records[key])
    del workspace.files["FVOICE"]
    await connector.run_sync()
    assert key not in store.records


async def test_transcript_edit_updates_revision_and_pagination_is_complete(workspace, store, checkpoints) -> None:
    workspace.page_size["files.list"] = 1
    workspace.files["FVOICE2"] = {**workspace.files["FVOICE"], "id": "FVOICE2"}
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    key = voice.voice_id(SECRET, "FVOICE")
    old = store.records[key].external_revision_id
    assert voice.voice_id(SECRET, "FVOICE2") in store.records
    workspace.files["FVOICE"]["transcription"]["preview"]["content"] = "An edited transcript."
    await connector.run_sync()
    assert store.records[key].external_revision_id != old
    assert "An edited transcript." in await content(connector, store.records[key])


async def test_incomplete_acl_never_creates_a_record(workspace, store, checkpoints) -> None:
    workspace.files["FVOICE"].pop("shares")
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    assert voice.voice_id(SECRET, "FVOICE") not in store.records
    assert connector._full_sync_read_failed


async def test_missing_stt_config_is_actionable_and_does_not_index_empty_text(workspace, store, checkpoints, monkeypatch) -> None:
    workspace.files["FVOICE"].pop("transcription")
    monkeypatch.setattr(voice, "get_stt_model_instance", AsyncMock(return_value=None))
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    with pytest.raises(HTTPException) as error:
        await content(connector, store.records[voice.voice_id(SECRET, "FVOICE")])
    assert error.value.status_code == 409
    assert "Speech-to-Text" in error.value.detail


async def test_fallback_transcribes_audio_with_background_identity(workspace, store, checkpoints, monkeypatch) -> None:
    from app.services.model_identity.call_context import current_call_context

    workspace.files["FVOICE"].pop("transcription")
    # File bytes are tested separately below; this case exercises adapter selection and identity.
    monkeypatch.setattr(voice, "_download", AsyncMock(return_value=b"synthetic-audio"))
    async def transcribe(audio, **kwargs) -> str:
        ctx = current_call_context()
        assert ctx.principal.service_name == "indexing" and not ctx.principal.is_user
        assert audio == b"synthetic-audio" and kwargs["mime"] == "audio/mp4"
        return "Synthetic fallback transcription."
    monkeypatch.setattr(voice, "get_stt_model_instance", AsyncMock(return_value=(SimpleNamespace(transcribe=transcribe), {})))
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    text = await content(connector, store.records[voice.voice_id(SECRET, "FVOICE")])
    assert "Synthetic fallback transcription." in text
    assert "Transcript source: Speech-to-Text transcription" in text


@pytest.mark.parametrize("personal", [False, True])
async def test_file_indexing_filter_still_applies(workspace, store, checkpoints, personal) -> None:
    connector, config = await (personal_connector if personal else workspace_connector)(store, checkpoints)
    config.config["filters"] = {"indexing": {"values": {
        "files": {"operator": "is", "value": False, "type": "boolean"},
    }}}
    await connector.run_sync()
    assert store.records[voice.voice_id(SECRET, "FVOICE")].indexing_status == ProgressStatus.AUTO_INDEX_OFF.value


@pytest.mark.parametrize("url", ["https://evil.example/audio", "http://files.slack.com/audio", "https://files.slack.com.evil.example/audio"])
async def test_download_never_sends_slack_token_to_untrusted_host(workspace, store, checkpoints, url) -> None:
    connector, _ = await workspace_connector(store, checkpoints)
    with pytest.raises(HTTPException) as error:
        await voice._download(connector, {"url_private": url})
    assert error.value.status_code == 409
    assert not workspace.downloads_seen


@pytest.mark.parametrize("status,expected", [(302, 500), (401, 409), (403, 403), (404, 404), (429, 429), (503, 502)])
async def test_download_status_does_not_fall_through_to_transcription(workspace, store, checkpoints, status, expected) -> None:
    import httpx
    url = workspace.files["FVOICE"]["url_private"]
    workspace.downloads[url] = httpx.Response(status, headers={"location": "https://evil.example/"})
    connector, _ = await workspace_connector(store, checkpoints)
    with pytest.raises(HTTPException) as error:
        await voice._download(connector, workspace.files["FVOICE"])
    assert error.value.status_code == expected
    assert len(workspace.downloads_seen) == 1


async def test_download_bounds_actual_bytes_and_rejects_sign_in_html(workspace, store, checkpoints, monkeypatch) -> None:
    import httpx
    file = workspace.files["FVOICE"]
    url = file["url_private"]
    connector, _ = await workspace_connector(store, checkpoints)
    workspace.downloads[url] = b"synthetic audio"
    assert await voice._download(connector, file) == b"synthetic audio"
    monkeypatch.setattr(voice, "MAX_AUDIO_BYTES", 16)
    workspace.downloads[url] = b"x" * 17
    with pytest.raises(HTTPException) as error:
        await voice._download(connector, file)
    assert error.value.status_code == 413
    workspace.downloads[url] = httpx.Response(200, headers={"content-type": "text/html"}, text="sign in")
    with pytest.raises(HTTPException) as error:
        await voice._download(connector, file)
    assert error.value.status_code == 409


async def test_vtt_is_used_before_stt_and_partial_preview_is_ignored(workspace, store, checkpoints, monkeypatch) -> None:
    file = workspace.files["FVOICE"]
    file["transcription"]["preview"]["has_more"] = True
    file["vtt"] = "https://files.slack.com/voice.vtt"
    workspace.downloads[file["vtt"]] = b"WEBVTT\n\n1\n00:00.000 --> 00:01.000\n<v Speaker>Complete &amp; native.</v>\n"
    stt = AsyncMock(side_effect=AssertionError("Do not transcribe audio when captions exist"))
    monkeypatch.setattr(voice, "get_stt_model_instance", stt)
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    text = await content(connector, store.records[voice.voice_id(SECRET, "FVOICE")])
    assert "Complete & native." in text and "A synthetic voice note." not in text
    assert "Transcript source: Slack transcript" in text
    stt.assert_not_awaited()


async def test_unknown_channel_scan_keeps_existing_access(workspace, store, checkpoints) -> None:
    from slack_behaviour_fakes import SlackError
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    key = voice.voice_id(SECRET, "FVOICE")
    grants = list(store.record_permissions[key])
    workspace.fail("files.list", SlackError("internal_error"), times=None)
    await connector.run_sync()
    assert store.record_permissions[key] == grants


def test_native_transcript_shapes_and_incomplete_content() -> None:
    assert voice.slack_transcript({"transcription": {"text": " hello "}}) == "hello"
    assert voice.slack_transcript({"transcription": {"lines": [{"contents": "one"}, {"contents": "two"}]}}) == "one\ntwo"
    assert voice.slack_transcript({"transcription": {"status": "pending", "text": "partial"}}) is None
    assert voice.slack_transcript({"transcription": {"preview": {"content": "partial", "has_more": True}}}) is None
    assert voice.slack_transcript({"transcription": {"lines": [{"contents": "one"}, {}]}}) is None


@pytest.mark.parametrize("result", ["", RuntimeError("sensitive provider error")])
async def test_provider_failure_never_returns_empty_or_sensitive_transcript(workspace, store, checkpoints, monkeypatch, result) -> None:
    workspace.files["FVOICE"].pop("transcription")
    workspace.downloads[workspace.files["FVOICE"]["url_private"]] = b"synthetic-audio"
    adapter = SimpleNamespace(transcribe=AsyncMock(**({"side_effect": result} if isinstance(result, Exception) else {"return_value": result})))
    monkeypatch.setattr(voice, "get_stt_model_instance", AsyncMock(return_value=(adapter, {})))
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    with pytest.raises(HTTPException) as error:
        await content(connector, store.records[voice.voice_id(SECRET, "FVOICE")])
    assert error.value.status_code == 503
    assert "sensitive provider error" not in error.value.detail


async def test_native_mentions_resolve_without_registering_or_granting_people(workspace, store, checkpoints) -> None:
    workspace.add_user("UOUTSIDER", "other@example.test", "Other Person")
    # This user is resolved lazily, rather than being part of the synced directory.
    original_list = workspace._api_users_list
    workspace._api_users_list = lambda params: {
        **(page := original_list(params)), "members": [u for u in page["members"] if u["id"] != "UOUTSIDER"],
    }
    workspace.files["FVOICE"]["transcription"]["preview"]["content"] = "Talk to <@UOUTSIDER> :wave:."
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    key = voice.voice_id(SECRET, "FVOICE")
    text = await content(connector, store.records[key])
    assert "Other Person" in text and "other@example.test" in text and "👋" in text
    assert "UOUTSIDER" not in store.app_users
    assert "other@example.test" not in {p.email for p in store.record_permissions[key]}


async def test_caption_edit_changes_revision_even_when_slack_preview_is_unchanged(workspace, store, checkpoints) -> None:
    file = workspace.files["FVOICE"]
    file["transcription"]["preview"]["has_more"] = True
    file["vtt"] = "https://files.slack.com/voice.vtt"
    workspace.downloads[file["vtt"]] = b"WEBVTT\n\n00:00.000 --> 00:01.000\nFirst complete caption.\n"
    connector, _ = await workspace_connector(store, checkpoints)
    await connector.run_sync()
    key = voice.voice_id(SECRET, "FVOICE")
    before = store.records[key].external_revision_id
    workspace.downloads[file["vtt"]] = b"WEBVTT\n\n00:00.000 --> 00:01.000\nEdited complete caption.\n"
    await connector.run_sync()
    assert store.records[key].external_revision_id != before
