# Upstream synchronization after the access/audit release

This sync joins EXODIA main `8adcd5f28acf2fb065012df371c7801eda60e664` with upstream `e29bf542f66e8094b40b2b931ed2bcac352abfee` (192 upstream commits). Track promotion and final CI evidence in [PR #54](https://github.com/exodia-tech/pipeshub-ai/pull/54) and [EXO-1117](https://linear.app/exodiatech/issue/EXO-1117).

The preceding access/audit release was deployed and verified at `https://brain.exodia.ws` on `8adcd5f`: public health reported that commit, all component health checks passed, anonymous group/audit reads returned 401, and the authenticated Groups/Audit screens and mobile calendar/help controls worked. That verification does not establish that this upstream sync is deployed.

## Integration decisions

- Reuse upstream's source-revocation, whole-answer and turn redaction. Preserve the fork's confirmed group-policy requirement, restrictive legacy-history rules, safe hidden-message allowlist and source permission upper bound. Tool-only pages also check group policy. Already confirmed policy is reused within one request; an unknown policy fails closed.
- Follow-up, agent, streaming and regeneration paths use the shared history handler. Hidden content sent to a model is blank; the browser receives the canonical access notice. A fresh-answer exception cannot bypass an unconfirmed group policy.
- Keep the existing Mongo administrator audit adapter and sign-in's bounded, fail-open audit write alongside upstream canonical operational logs. Preserve tool-approval outcomes, safe-retrieval restrictions and usage transports.
- Keep EXODIA assets, blue theme, Lucide wrapper, font and rounded controls. Brand newly added UI messages and complete Italian strings, plural forms and accessible labels.
- Keep the EXODIA 3D knowledge graph under `knowledgeGraph` translations and upstream's separate code graph under `graph`. Its upstream feature flag remains off by default; no extra connector is enabled.
- Linear's fresh checkpoint includes both archived-record relisting and the fork's project-folder hierarchy: `projects-with-archived-folders` and `team_project_issues_v2_<team>`.
- Preserve trusted, isolated Coolify CI and full coverage thresholds. Test Node 22 and 24; build on Node 24 with Debian Bookworm compatibility. Keep compact streamed logs with full diagnostic artifacts. Python type findings retain upstream's nonblocking policy; tool/runtime failures still fail.

## Review and verification

**Standards:** no material documented-standard violations or actionable smells found in the integration review.

**Spec:** no material specification violations found. Review covered integration-sensitive paths, not every line of the 192 upstream commits. A branded test-fixture mismatch was corrected before promotion.

Local checks include backend/frontend type checks and backend production build; all 5,318 frontend tests across 519 files passed with coverage above the unchanged gates. Frontend coverage was 61.63% statements, 56.61% branches, 57.42% functions and 63.06% lines. Locale parity/key checks and their 19 tests passed. The combined history suite passed 65 tests, including a reproduced tool-only history regression and missing-policy denial. Python endpoint/Linear, agent/audit, code-graph/permission and usage checks are recorded with the final CI evidence in the PR. Upstream test-tool path comparisons were normalized for Windows without relaxing their assertions.

Promotion requires the full Node coverage gate and core validation workflow on the selected Coolify runners. The PR records exact tested commits, job links and any subsequent fixes. Main remains a manual deployment target; merging this sync is not a deployment or a live-provider acceptance test.

## Boundaries

No company data ingestion, connector setup, provider purchases, credential changes or automatic upgrades were performed. Real external connector synchronization, full Python-suite/type cleanliness, large-tenant performance and a complete upstream line-by-line review are not claimed. Existing access/audit limitations remain in [access-groups-audit.md](./access-groups-audit.md).

Persistent volumes are not backups. Backup destination and restore testing remain unresolved in [EXO-461](https://linear.app/exodiatech/issue/EXO-461).
