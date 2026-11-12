"""Channel-scoped Slack audio transcripts; a mention never creates a grant."""

from __future__ import annotations

import hashlib
import json
import re
from html import unescape
from typing import TYPE_CHECKING, Any
from urllib.parse import urlencode

import emoji
import httpx
from fastapi import HTTPException

from app.config.constants.arangodb import Connectors, MimeTypes, OriginTypes
from app.connectors.core.base.error.stream_errors import map_source_status
from app.connectors.core.registry.filters import IndexingFilterKey
from app.connectors.sources.slack.common.file_urls import slack_file_url
from app.connectors.sources.slack.common.huddle import (
    _file_info,
    _readable_content,
    _revoke,
    channel_share,
)
from app.connectors.sources.slack.common.stream_errors import (
    sanitize_retry_after,
    slack_stream_error,
)
from app.models.entities import FileRecord, ProgressStatus, RecordGroupType, RecordType
from app.services.model_identity.principal import service_principal
from app.services.model_identity.runtime import call_scope
from app.services.model_identity.workload import Workload
from app.utils.llm import get_stt_model_instance

if TYPE_CHECKING:
    from app.connectors.sources.slack.common.huddle import HuddleConnector
    from app.models.permission import Permission

VOICE_PREFIX = "slack-voice:"
MAX_AUDIO_BYTES = 25 * 1024 * 1024


def is_voice_file(file: dict[str, Any]) -> bool:
    return not file.get("is_external") and file.get("mode") != "external" and file.get("filetype") != "remote" and (
        str(file.get("mimetype", "")).startswith("audio/")
        or file.get("media_display_type") == "audio"
        or file.get("filetype") in ("mp3", "m4a", "aac", "ogg", "wav", "flac", "opus")
    )


def voice_id(channel: str, file_id: str) -> str:
    return f"{VOICE_PREFIX}{channel}:{file_id}"


def parse_voice_id(external_id: str) -> tuple[str, str] | None:
    if not external_id.startswith(VOICE_PREFIX):
        return None
    parts = external_id[len(VOICE_PREFIX):].split(":")
    return (parts[0], parts[1]) if len(parts) == 2 and all(parts) else None


def message_share(file: dict[str, Any], channel: str) -> dict[str, Any] | None:
    """Only fresh, explicit channel/message evidence qualifies for ingestion."""
    shares = file.get("shares")
    if not isinstance(shares, dict):
        return None
    for bucket in shares.values():
        if not isinstance(bucket, dict) or not isinstance(bucket.get(channel), list):
            continue
        for share in bucket[channel]:
            if isinstance(share, dict) and re.fullmatch(r"\d+\.\d+", str(share.get("ts", ""))):
                return share
    return None


def message_url(connector: HuddleConnector, channel: str, share: dict[str, Any]) -> str:
    domain = connector.workspace_domain
    if not domain or not re.fullmatch(r"[a-zA-Z0-9-]+", domain):
        raise ValueError("Slack workspace domain is unavailable")
    url = f"https://{domain}.slack.com/archives/{channel}/p{share['ts'].replace('.', '')}"
    thread = share.get("thread_ts")
    if isinstance(thread, str) and re.fullmatch(r"\d+\.\d+", thread):
        url += "?" + urlencode({"thread_ts": thread, "cid": channel})
    return url


def slack_transcript(file: dict[str, Any]) -> str | None:
    transcript = file.get("transcription")
    if not isinstance(transcript, dict):
        return None
    # A pending or failed transcript can contain partial lines. Use audio instead.
    if transcript.get("status") not in (None, "complete", "completed", "available"):
        return None
    preview = transcript.get("preview")
    if (isinstance(preview, dict) and preview.get("has_more") is False
            and isinstance(preview.get("content"), str) and preview["content"].strip()):
        return preview["content"].strip()
    if transcript.get("has_more") is True:
        return None
    if isinstance(transcript.get("text"), str) and transcript["text"].strip():
        return transcript["text"].strip()
    lines = transcript.get("lines")
    if not isinstance(lines, list) or not lines:
        return None
    result = []
    for line in lines:
        text = line.get("contents") if isinstance(line, dict) else None
        if not isinstance(text, str) or not text.strip():
            return None
        result.append(text.strip())
    return "\n".join(result)


async def _download(connector: HuddleConnector, file: dict[str, Any]) -> bytes:
    size = file.get("size")
    if isinstance(size, (int, float)) and size > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Slack voice note exceeds the 25 MiB transcription limit.")
    url = slack_file_url(file)
    if not url:
        raise HTTPException(409, "Slack does not expose a supported, Slack-hosted audio download.")
    await connector.rate_limiter.acquire(3)
    ds = await connector._fresh_datasource(retry_rate_limits=False)
    audio = bytearray()
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as http:
            async with http.stream("GET", url, headers={"Authorization": f"Bearer {ds.access_token}"}) as response:
                if response.status_code != 200:
                    raise map_source_status(response.status_code, connector=connector.display_name,
                                            retry_after=sanitize_retry_after(response.headers.get("retry-after")))
                if "text/html" in response.headers.get("content-type", ""):
                    raise map_source_status(401, connector=connector.display_name)
                async for chunk in response.aiter_bytes(64 * 1024):
                    if len(audio) + len(chunk) > MAX_AUDIO_BYTES:
                        raise HTTPException(413, "Slack voice note exceeds the 25 MiB transcription limit.")
                    audio.extend(chunk)
    except httpx.HTTPError:
        raise HTTPException(503, "Slack voice-note download failed; retry later.") from None
    if not audio:
        raise HTTPException(409, "Slack returned empty audio.")
    return bytes(audio)


async def _audio_transcript(connector: HuddleConnector, file: dict[str, Any]) -> str:
    instance = await get_stt_model_instance(connector.config_service)
    if instance is None:
        raise HTTPException(409, "Configure a Speech-to-Text provider to transcribe Slack voice notes without a Slack transcript.")
    audio = await _download(connector, file)
    adapter, _config = instance
    async with call_scope(
        service_principal("indexing", connector.data_entities_processor.org_id), Workload.INDEXING,
        config_service=connector.config_service, connector_id=connector.connector_id,
    ):
        try:
            text = await adapter.transcribe(audio, mime=file.get("mimetype") or "audio/mp4", filename=file.get("name"))
        except Exception as exc:
            # Provider exceptions can contain signed URLs or credentials.
            connector.logger.warning("Voice-note transcription failed for file %s (%s)", file.get("id"), type(exc).__name__)
            raise HTTPException(503, "Slack voice-note transcription failed; check the Speech-to-Text provider and retry.") from None
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(503, "Speech-to-Text returned no transcript for this voice note.")
    return text.strip()


def _vtt_text(content: str) -> str | None:
    if not content.lstrip("\ufeff").startswith("WEBVTT"):
        return None
    cues = []
    for block in re.split(r"\r?\n\s*\r?\n", content):
        lines = block.splitlines()
        for index, line in enumerate(lines):
            if " --> " in line:
                text = unescape(re.sub(r"<[^>]*>", "", "\n".join(lines[index + 1:]))).strip()
                if text:
                    cues.append(text)
                break
    return "\n".join(cues) or None


async def _native_transcript(connector: HuddleConnector, file: dict[str, Any]) -> str | None:
    transcript = slack_transcript(file)
    vtt = file.get("vtt")
    if not transcript and isinstance(vtt, str):
        if vtt.startswith("https://"):
            # Apply the same host allowlist as audio; never send a token to a remote caption URL.
            caption = {"url_private": vtt}
            if slack_file_url(caption):
                try:
                    transcript = _vtt_text((await _download(connector, caption)).decode("utf-8-sig", errors="replace"))
                except HTTPException as exc:
                    if exc.status_code != 404:
                        raise
        else:
            transcript = _vtt_text(vtt)
    return transcript


async def stream_voice(connector: HuddleConnector, channel: str, file_id: str) -> bytes:
    info = await _file_info(connector, file_id, retry_rate_limits=False)
    if not info or not info.success:
        raise slack_stream_error(info, connector=connector.display_name)
    file = info.data.get("file") if isinstance(info.data, dict) else None
    if (not isinstance(file, dict) or file.get("id") != file_id or not is_voice_file(file)
            or channel_share(file, channel) is not True or not (share := message_share(file, channel))):
        raise map_source_status(403, connector=connector.display_name)
    url = message_url(connector, channel, share)
    transcript = await _native_transcript(connector, file)
    source = "Slack transcript" if transcript else "Speech-to-Text transcription"
    if not transcript:
        transcript = await _audio_transcript(connector, file)
    transcript = await _readable_content(connector, transcript)
    channel_name = connector.channel_id_to_name_cache.get(channel) or channel
    content = (f"# Voice note\n\n[Original message in #{channel_name}]({url})\n\n"
               f"Channel ID: {channel}\n\nMessage timestamp: {share['ts']}\n\nSlack file ID: {file_id}\n\n"
               f"Transcript source: {source}\n\n## Transcript\n\n{transcript}\n")
    return content.encode("utf-8")


async def _listed_voice_files(connector: HuddleConnector, channel: str) -> set[str]:
    page = 1
    result = set()
    while True:
        await connector.rate_limiter.acquire(3)
        ds = await connector._fresh_datasource()
        response = await ds.files_list(channel=channel, types="all", count=200, page=page,
                                       show_files_hidden_by_limit=1, ts_from=connector._compute_sync_window_oldest())
        if not response or not response.success:
            raise slack_stream_error(response, connector=connector.display_name)
        data = response.data
        paging = data.get("paging") if isinstance(data, dict) else None
        if (not isinstance(data, dict) or not isinstance(data.get("files"), list)
                or not isinstance(paging, dict) or paging.get("page") != page
                or type(paging.get("page")) is not int
                or type(paging.get("pages")) is not int or paging["pages"] < 0):
            raise ValueError("Slack returned an incomplete voice-note listing")
        for file in data["files"]:
            if not isinstance(file, dict) or not isinstance(file.get("id"), str) or not file["id"]:
                raise ValueError("Slack returned incomplete file metadata")
            if is_voice_file(file):
                result.add(file["id"])
        if page >= paging["pages"]:
            return result
        page += 1


async def sync_voice_notes(
    connector: HuddleConnector, channels: dict[str, list[Permission]], *, personal: bool,
    unknown_channels: set[str] | None = None, channels_complete: bool = True,
) -> None:
    stored = {}
    cursor = None
    while True:
        records = await connector.data_entities_processor.get_records_by_status(
            connector_id=connector.connector_id, status_filters=None, limit=200, after_key=cursor,
        )
        stored.update((record.external_record_id, record) for record in records if parse_voice_id(record.external_record_id))
        if len(records) < 200:
            break
        if not records[-1].id or records[-1].id == cursor:
            raise ValueError("Invalid stored-record pagination")
        cursor = records[-1].id
    for channel, permissions in channels.items():
        try:
            ids = await _listed_voice_files(connector, channel)
            ids.update(parts[1] for key in stored if (parts := parse_voice_id(key)) and parts[0] == channel)
        except Exception as exc:
            connector._full_sync_read_failed = True
            connector.logger.warning("Voice-note listing failed for channel %s: %s", channel, exc)
            continue
        for file_id in ids:
            external_id = voice_id(channel, file_id)
            existing = stored.get(external_id)
            try:
                info = await _file_info(connector, file_id)
                if not info or not info.success:
                    error = getattr(info, "error", None)
                    if error in ("file_deleted", "file_not_found", "not_visible"):
                        if existing:
                            await _revoke(connector, existing, personal=personal)
                        continue
                    raise slack_stream_error(info, connector=connector.display_name)
                file = info.data.get("file") if isinstance(info.data, dict) else None
                if not isinstance(file, dict) or file.get("id") != file_id:
                    raise ValueError("Slack returned incomplete voice-note metadata")
                shared = channel_share(file, channel)
                if shared is None:
                    raise ValueError("Slack did not return current channel shares")
                if not shared or not is_voice_file(file):
                    if existing:
                        await _revoke(connector, existing, personal=personal)
                    continue
                share = message_share(file, channel)
                if not share:
                    raise ValueError("Slack did not return the sharing message")
                # Signed download URLs expire independently of the actual audio.
                revision = {key: file.get(key) for key in ("id", "size", "timestamp", "updated", "edit_timestamp", "transcription")}
                native = await _native_transcript(connector, file)
                if native:
                    revision["native_transcript"] = await _readable_content(connector, native)
                revision["message"] = share["ts"]
                digest = hashlib.sha256(json.dumps(revision, sort_keys=True).encode()).hexdigest()
                title = unescape(str(file.get("title") or file.get("name") or "Voice note"))
                title = connector._replace_mentions_in_text(
                    emoji.emojize(title, language="alias"), connector.user_id_to_name_cache, connector.channel_id_to_name_cache,
                )
                record = FileRecord(
                    org_id=connector.data_entities_processor.org_id, record_name=f"{title} — transcript.md",
                    record_type=RecordType.FILE, external_record_id=external_id, external_revision_id=digest,
                    external_record_group_id=channel, record_group_id=connector.channel_groups_cache.get(channel),
                    record_group_type=RecordGroupType.SLACK_CHANNEL, connector_id=connector.connector_id,
                    connector_name=Connectors.SLACK if personal else Connectors.SLACK_WORKSPACE,
                    version=0, origin=OriginTypes.CONNECTOR, mime_type=MimeTypes.MARKDOWN.value,
                    is_file=True, extension="md", inherit_permissions=False,
                    source_created_at=int(file.get("created") or 0) * 1000,
                    source_updated_at=int(file.get("updated") or file.get("created") or 0) * 1000,
                    weburl=message_url(connector, channel, share),
                    indexing_status=(ProgressStatus.QUEUED.value if (
                        connector.indexing_filters.is_enabled(IndexingFilterKey.FILES)
                        and (not personal or connector._is_channel_indexing_enabled(channel))
                    ) else ProgressStatus.AUTO_INDEX_OFF.value),
                )
                await connector.data_entities_processor.on_new_records([(record, permissions)], replace_permissions=True)
                legacy = await connector.data_entities_processor.get_record_by_external_id(
                    connector_id=connector.connector_id, external_record_id=file_id,
                )
                if legacy and legacy.record_type == RecordType.FILE:
                    await connector.data_entities_processor.on_record_deleted(legacy.id)
            except Exception as exc:
                connector._full_sync_read_failed = True
                connector.logger.warning("Voice-note sync failed for channel %s, file %s: %s", channel, file_id, exc)
    if channels_complete:
        for key, record in stored.items():
            channel = parse_voice_id(key)[0]
            if channel not in channels and channel not in (unknown_channels or set()):
                await _revoke(connector, record, personal=personal)
