# Coolify verification workers

GitHub schedules verification jobs; Coolify runs them in disposable containers on
`contabo-48gb-12vcpu`. The pool has label `exodia-brain`, one concurrent runner,
4 CPUs, 8 GB RAM, a 90-minute job limit and a 240-minute queue limit. The runner
image is pinned to `ghcr.io/actions/actions-runner:2.338.2`.

The native pool uses **No Docker** mode. It has no production credentials or host
Docker socket. Pull-request jobs are refused: maintainers dispatch verification
against a reviewed branch. This matters because the fork is public. The GitHub
runner group permits only `exodia-tech/pipeshub-ai` and `unit-test.yml` / `main.yml`
on `main` and `codex/exodia-audit`. Review that temporary branch entry after merge.

The existing `exodia-tech` GitHub App has Actions read permission, organization
self-hosted runners write permission and the `workflow_job` subscription. Secrets
remain in Coolify/GitHub, never in this repository.

## Verify a candidate

Dispatch `unit-test.yml` on the candidate branch with `node-only: true` to run the
**entire Node unit suite**, including the existing 89% lines/statements, 90%
functions and 80% branches coverage gates. The run explicitly skips Python and
Redis jobs; it is not evidence that those suites passed. The input defaults to
false, so normal/full runs retain every existing gate. Dispatch `main.yml` for
the build, type, locale and lint checks. Check the run's commit SHA and runner
name before treating it as merge evidence.

The Redis cluster integration job needs Docker. No Docker mode cannot run it;
use an approved isolated Docker runner before claiming that full workflow is
green. Do not enable privileged Docker or restart the production host's Docker
daemon just to make a check pass. Full Python coverage and live connector/bot
acceptance also need their own evidence.

Runner settings and executions:
https://coolify.exodia.ws/server/fnbahuvghsbyyoewxacg1dho/github-runners

Native runner documentation:
https://coolify.io/docs/core/infrastructure/servers/github-actions-runners
