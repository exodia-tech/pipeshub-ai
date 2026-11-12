# Slack voice notes

Both Slack Workspace and personal Slack connectors discover Slack-hosted audio
files in the channels selected by the existing sync filters. No new Slack scopes
are needed beyond the existing `files:read` and conversation scopes.

Each channel/file pair becomes a Markdown transcript inside that channel's
folder, with the stable external ID `slack-voice:<channel-id>:<file-id>`. Its source
URL opens the sharing message, including its thread when Slack returns one. The
preview also records the channel ID, sharing-message timestamp, file ID and
whether Slack or the configured Speech-to-Text provider supplied the transcript.
When an audio file has multiple shares in the same channel, the first message
in Slack's current share metadata is used; other channels get separate records.

## Transcript selection

1. A complete native `transcription` text, full preview (`has_more=false`), or
   complete lines from `files.info`.
2. Native WebVTT captions, inline or downloaded from `files.slack.com`.
3. The existing default Speech-to-Text provider configured in AI Models.

A partial or pending transcript is never indexed as complete. Missing STT
configuration produces an actionable 409; a failed or empty transcription fails
indexing instead of silently producing an empty document. Audio downloads have
a 25 MiB limit, enforced on both declared size and received bytes. Redirects are
not followed, and Slack credentials are sent only to the existing allowlisted
Slack file host. External/remote audio is excluded.

Fallback transcription runs when indexing or opening the transcript, under the
indexing service identity. Reopening/reindexing a note without native captions
can call STT again, incur provider charges, and yield slightly different text.
The connector does not identify speakers from their voice. Native user mentions
and emoji use the same readable renderer as Huddle notes; resolving a name/email
does not register a person or grant access.

## Permissions and reconciliation

- Company records have explicit grants from the verified source channel and do
  not inherit blanket folder permissions. Each channel copy has its own grants.
- Personal records remain behind the connected user's existing personal App gate.
- Both a current channel share and a sharing-message timestamp are required
  before ingestion. Opening a transcript rechecks that evidence before fetching
  captions, downloading audio or calling STT.
- Scheduled reconciliation refreshes existing records even outside the discovery
  date window. Confirmed unsharing/lost visibility removes company grants or
  deletes the personal copy. Unknown/failed ACL reads keep existing access and
  mark coverage incomplete; they never introduce a new grant.
- A channel excluded from a complete scope scan has its old copies revoked.
  Partial channel scans preserve unknown channels. The connector never joins a
  channel for voice-note discovery and does not ingest direct individual file
  shares lacking verified conversation/message evidence.
- A successfully migrated voice transcript replaces its old generic audio
  attachment record. File indexing filters still apply.

## References

- [Slack file metadata, sharing and transcription fields](https://docs.slack.dev/reference/objects/file-object/)
- [files.info and token visibility](https://docs.slack.dev/reference/methods/files.info/)
- [Paginated channel file discovery](https://docs.slack.dev/reference/methods/files.list/)
- [Remote file URLs must not receive Slack credentials](https://docs.slack.dev/messaging/working-with-files/)

The source API is simulated in the behavior suite, and the STT adapter is
simulated. A real workspace voice note and the deployment's chosen STT provider
must still be exercised before production rollout.
