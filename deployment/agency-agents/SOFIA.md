# Sofia: one project at a time

Sofia prepares cited project recaps, suggested Linear changes and **unsent** client emails. A single private, human-owned Brain agent is created per project. `sofia.py` generates a manual-only create-agent payload with no connector, knowledge, MCP, action tool, web search, organization-wide sharing or automatic schedule. The project key in the name/tags/prompt is a label, not an access-control mechanism. Share only notes the reviewer is authorized to use; the supplied pilot data is synthetic. No source permissions or user accounts are provisioned by this template.

```sh
python deployment/agency-agents/sofia.py demo-verde "Progetto Verde" --language it
python -m unittest discover -s deployment/agency-agents -p test_sofia.py
```

Submit the generated payload only using an authenticated user with `agent:write`, via `POST /api/v1/agents/create`, after checking the agent list for an existing instance. Create the agent in the account of its responsible human; use the Brain picture UI or authenticated avatar upload endpoint for the portrait. The agent's picture is separate from its Slack app icon. Record the resulting ID and verify readback and actual small/large rendering. The template itself performs no network calls and the example does not create an agent.

## Synthetic pilot

Use `sofia-demo-fixture.json` and its `example.invalid` source reference, which is not a real link or client record. Supply only its synthetic note body and labelled source URL to the private agent manually. Ask for an Italian recap and draft follow-up. A human should verify that it says the prototype review was agreed, assigns Amina only the draft-screen task, leaves the deadline unspecified, treats Luca's historical-data question as open and calls the cost estimate unapproved. It must label any proposed Linear issue and email as a draft, cite the fixture and never send or write either. This is a test scenario, not an already verified model result.

## Source and scheduling boundary

The official [Wispr Flow MCP documentation](https://docs.wisprflow.ai/articles/9551372685-connect-an-mcp-client-to-wispr-flow-remote-mcp-server) describes read-only meeting notes, summaries and permitted transcripts. Authorization covers the account's accessible meetings, including existing content; there is no per-meeting authorization in Wispr. A shared-note link does not guarantee transcript access. The Brain catalog entry is present, but the last deployment checkpoint records account connection and meeting retrieval as unverified. A Codex Wispr connection does not prove Brain's own account is connected. Do not turn on the connector for Sofia until the owner has reviewed the account-wide access and the project mapping, and the shared runtime can enforce project/source ACLs for each read.

The [native public-research scheduler](../../docs/native-agent-schedules.md) intentionally rejects company knowledge, MCP, action tools and service agents. A separate shared runtime task must provide explicit project grants, a trusted caller identity, per-read access checks, durable project-scoped run state and audit/usage attribution. Human-owned manual agents are the initial choice; a service identity is appropriate only once scoped execution and source permissions are implemented and verified. Do not grant organization-wide user access just to simulate service access.

`preflight` classifies a meeting using a **trusted server-side** project, source allowlist and fresh authorization decision supplied by that future runtime. Wrong project, source or denied access is denied; incomplete material stays pending; a repeated revision is ignored; an updated revision is separately flagged for review. The caller must key previous revisions by organization, project, source and meeting and persist them atomically. A caller-provided `source_authorized` flag or project label is not proof of access. The function does not fetch, persist, schedule, send, create drafts, detect webhooks or implement authorization. It deliberately cannot itself activate a workflow.

Before unattended processing: select one project and meeting, verify account/meeting access and transcript readiness, define approved knowledge destinations and audience, establish the client's language and sharing rules, test denied-source and cross-project cases, confirm how meeting completion is detected, and review the generated recap against that meeting. No supported webhook or project-level authorization is established by this template. Avoid polling or posting until a verified trigger and delivery policy exist.

## Slack

Prepare one distinct `Sofia · EXODIA` app per approved project routing context, labelled as AI, with the same square portrait. Choose the exact channel and human audience per project; client-channel membership and scope installation require review. Minimum intended messaging scopes are `chat:write`, `app_mentions:read`, `im:history`, `im:read`, `users:read` and `users:read.email`, subject to actual function and review. Do not grant channel history or file access merely for replies. Configure the Brain bot-to-agent mapping only after exact app, scopes and destination are approved; verify Slack signature validation and matched Slack/Brain identities. Do not claim a bot is installed, a channel joined or delivery verified until actually checked. No client email may be sent by the bot.
