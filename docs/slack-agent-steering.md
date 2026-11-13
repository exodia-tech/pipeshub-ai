# Slack follow-ups during a run

Reply in the same bot thread to clarify your request while the agent is working. Steering is silent: the bot restores native thinking rotation and the running agent reads the update at its next safe step. An in-flight model or tool call is not forcibly interrupted. A stale tool selection is denied until the agent has read the update; streamed text superseded by an update is discarded.

The route matches workspace, bot, channel, thread and Slack requester. The scoped internal token is resolved to the requesting PipesHub user, the Node API verifies conversation access, and the query service separately verifies the run's exact user, organization and conversation. Steering changes no principal, membership or source permission. Another thread participant must address the bot to start their own authorized conversation.

Updates wait for the root run's start event. If the agent instead asks a pre-run question or has already finished, the reply becomes the next normal turn. Attachments wait for the existing turn to settle. Accepted text updates are included in conversation history; repeated Slack deliveries do not restart the rotation or append a second message.

The shared key-value store coordinates query workers. Each run accepts at most 20 updates of 8,000 characters, retains message IDs for deduplication, and deletes its inbox on cleanup. Abandoned state expires within one hour. Storage failures are surfaced rather than starting an overlapping run. Existing model identity, usage accounting and access checks remain in place.

The bot process owns its live stream registry. This deployment uses one bot process; replicated bot workers need shared event routing before this feature can span them. The backend inbox itself supports multiple query workers. No new Slack scopes are needed.

Verification covers delivery, owner/tenant/conversation isolation, concurrent updates, duplicate IDs, startup and completion boundaries, real Redis coordination, stale-tool blocking, sub-agent isolation and conversation-history persistence. A live Slack test should use a disposable private bot DM and synthetic content.

Slack audio requests use a complete native transcript (including VTT captions) when available. Otherwise the bot downloads at most 5 MiB from `https://files.slack.com` without redirects and calls the existing configured Speech-to-Text service as the verified requester. Transcription failure stops the reply with an actionable error. Audio authored by someone else is quoted attachment data, not a requester instruction. Reading a transcript does not create a record or grant anyone access. Earlier thread audio is not silently retranscribed. Native Slack transcripts do not incur a model call; provider transcription uses the existing speech usage attribution.

Generated images, audio, video and PDFs up to 20 MiB can be uploaded into the original Slack reply thread, retaining the Brain link. The private preview transport verifies conversation access, artifact access and exact conversation provenance; it accepts record IDs only. STAGING artifacts and unsupported/oversized media retain their links. Slack uploads require the bot's existing `files:write` authorization; missing permission or upload failure falls back to the authenticated Brain link. A preview is a Slack file copy governed by the destination channel or DM membership, independently of later Brain record revocation. The transport never creates a Brain record access grant or public URL.

Native status requests are ordered. Completion fences late status refreshes and clears after any in-flight update, so steering cannot leave a finished run showing as active.
