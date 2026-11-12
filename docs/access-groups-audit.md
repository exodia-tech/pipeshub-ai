# Access groups and administrator audit history

Organization administrators manage access groups in Workspace → Groups and inspect events in Workspace → Audit log. These features reuse the existing people picker, resource hierarchy, tables, calendar, help tooltip and detail drawer.

## Permission rules

- Source permissions are the upper bound. Allowing a Brain resource never grants otherwise-private Slack or Drive access.
- Rules can target an application, channel/folder or record. The most specific rule wins; equal-depth conflicts deny access. Restrictions from different groups intersect.
- An unrestricted group imposes no additional restriction. The administrator catalogue reveals denied resources for editing; the ordinary group view shows only permitted resources.
- Saved revisions prevent lost updates. A conflicting save returns 409 and must be reloaded. Reader counts are unknown when the full membership cannot be checked, including groups above the current 100-member bound.
- The shared graph read check, browse/search filtering, download authorization and RAG context gate enforce restrictions. Stored chat answers are checked again before display and follow-up use. Restricted viewers cannot replay old answers with denied or unverifiable provenance.
- Unavailable policy/identity checks fail closed on the protected paths. Release Node and Python together: an older query service cannot confirm the new history policy.

## Audit behavior

Events are stored in MongoDB's `exodiaAuditEvents` collection and queried only by a current administrator in the authenticated organization. JSON export covers the returned page; audit reads and exports are themselves recorded.

Coverage includes successful final sign-in, group administration and resource-policy changes, collection-sharing changes, document-stream starts/denials, and selected events from the platform agent factory. An intent without a confirmed outcome is not proof that an operation completed.

The agent adapter consumes upstream canonical events and the final `POST_AGENT` hook alongside the existing stream/transcript consumers. Approval-resume outcomes are included; redisplaying a saved result does not report another execution. Narrow, expiring service tokens supply the organization and actor. Prompts, tool arguments/results and raw errors are excluded from audit events.

An organization/event unique index makes identical service-event replays idempotent; conflicting metadata returns 409 without replacing the original. Administrative intent/success pairs remain separate. Index initialization must succeed before accepting agent events; historical duplicate agent events would require explicit reconciliation before rollout.

Agent writes have a two-second deadline and report failure without rerunning executed tools. There is no durable retry queue or exactly-once guarantee. Sign-in remains available when auditing fails, as agreed. Sensitive group/sharing mutations and document-stream starts require audit storage; a post-operation write failure leaves the outcome unconfirmed. There is no cross-store transaction.

## Verification

The local fixture servers are development-only, bind to loopback, require the isolated test database addresses and use synthetic people/documents. Never expose their session/bootstrap endpoints or point them at production data.

The security regression suites include:

| Boundary | Test files |
| --- | --- |
| Node API, Mongo storage, tenant/admin isolation, replay | `backend/nodejs/apps/tests/modules/user_management/routes/group-isolation.itest.ts` |
| Real Neo4j policy changes, chat/history and download denial | `backend/nodejs/apps/tests/modules/user_management/routes/access-groups.e2e.itest.ts` |
| Authenticated folder/group rules, malformed policies, revocation and bounded ancestry | `backend/python/tests/unit/api/routes/test_group_resource_access.py` |
| Token scopes and complete mounted-route policy inventory | `backend/python/tests/unit/api/middlewares/test_token_policy.py`, `backend/python/tests/unit/api/test_route_auth_policy.py` |
| Factory, hook decisions, tool approvals and audit failures | `backend/python/tests/unit/agents/agent_loop/test_audit.py`, existing adapter/approval suites |
| Native group/audit controls, calendar and help | Frontend tests under `workspace/groups`, `workspace/audit` and `components/ui` |

The real-service suites are opt-in and need the disposable fixture services; a skipped integration test is not passing evidence. External model/provider calls are mocked. Maintainer workspace launch/check commands and logs are recorded in `exodia-brain/deployment/access-control-local.md` and `test-access-audit-security.ps1` outside this checkout. UI screenshots use synthetic fixtures.

## Remaining boundaries

This change is not a claim that all enterprise controls are complete:

- Live connector permission synchronization, shared Slack response audiences, direct external MCP/API execution and unattended-run governance need their own acceptance evidence.
- The quiet internal `retrieve_artifact_content` helper and standalone control-plane instances do not emit the events consumed by this audit adapter.
- Neo4j has local real-service evidence. Arango has adapter changes but has not been exercised against a running instance for this feature; unsupported policy writers fail closed.
- Large-tenant performance, complete retention/deletion, independent log protection and backup restoration remain unverified. Persistent volumes are not backups.
- The newer graph UI reuses the shared listing service, but its complete cache/revocation and output behavior still needs the release-wide authorization review.

Track the remaining work in [enterprise readiness EXO-1103](https://linear.app/exodiatech/issue/EXO-1103), [permissions EXO-676](https://linear.app/exodiatech/issue/EXO-676), [audit EXO-463](https://linear.app/exodiatech/issue/EXO-463), [backups EXO-461](https://linear.app/exodiatech/issue/EXO-461) and [MCP governance EXO-677](https://linear.app/exodiatech/issue/EXO-677).
