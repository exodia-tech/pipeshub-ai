# Native public-research schedules

The agent creator can open **Agent options → Agent schedule** in chat, choose weekdays, local time and an IANA timezone, then save or pause the schedule. Run now works while paused. Recent runs link to ordinary, owner-scoped Brain conversations. All briefings remain drafts requiring review.

This pilot only supports active agents without company knowledge, action tools, MCP servers, skills, service-account delegation or personal context. Every run verifies the active human owner and current agent configuration and explicitly selects web search only. It uses the existing chat execution and usage path; unknown model pricing remains unpriced, and budgets are not enforced by this feature.

An organization administrator may configure `slackBotId` and `slackChannelId` through the schedule API. The bot must already be connected to that agent through the encrypted workspace bot registry, and invited to the intended channel. Delivery currently uses the existing single-organization Slack registry. Tokens never enter schedule requests or the ledger. Messages are labelled drafts, suppress special Slack mentions, and include a Brain link. The Brain conversation itself is not shared by posting its link.

The existing KV store persists settings and the last twenty run references. Compare-and-set claims prevent concurrent replicas from executing the same tick. Missed ticks coalesce into one reporting window. A conversation ID is saved before model execution. Uncertain model/delivery outcomes pause automation and require an administrator to inspect the conversation and Slack before deliberately running again; there is no automatic retry. This avoids duplicate posts after ambiguous network failures. The worker starts after HTTP listening, waits for query health before claiming, and drains before its storage/auth dependencies stop.

Schedule endpoints are documented in the OpenAPI specification. OAuth reads need `agent:read`; saving needs `agent:read`, `agent:write` and `agent:execute`; manual execution needs `agent:read` and `agent:execute`. Agent ownership is checked separately. Portrait URLs are restricted to deployment-owned raster assets under `/assets/agents/`.

Persistent KV storage is required. Persistent volumes are not backups: configure off-host backups and test restoration separately.
