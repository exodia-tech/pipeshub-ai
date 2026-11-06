# EXODIA Brain upstream sync — 2026-11-06

Upstream snapshot: `cd4a26f725dd8851a6deb89dc7ce619e4ff5d1e9`.
Branded starting point: `208c6de99a588e84380781909d3f82f35aa083e9`.

The merge retains both histories. It brings upstream functionality into the EXODIA fork while retaining the product mark, full wordmark, favicon, blue palette, Sora font, login artwork, EXODIA support/documentation links, email branding, Italian language registration and the existing deployment Compose file. Upstream's new branding defaults use EXODIA Brain. Deprecated upstream SAML code stays removed.

The upstream `nul.ts` helper and its test are named `strip-nul.ts` and `strip-nul.test.ts`, with all imports updated, because Windows cannot check out the reserved filename. This is the only change in compatibility commit `d214ce61b6f0a89b38e1f110039c7a530308f980`, whose parent is the upstream snapshot. Sanitization behavior is unchanged.

## Italian

All 1,541 newly required strings were translated locally by the language model, without an external translation service. Existing translations were retained where the source meaning had not changed. Interpolation placeholders were checked individually, Italian plural forms retained, and all eleven locale catalogues pass parity and literal-key validation. This is not a native-speaker editorial review.

## Verification

- Production frontend build: passed, including its type checks and static page generation.
- Frontend and backend type checks: passed.
- Frontend unit suite: 4,868 passed; one sidebar refresh-count test fails identically on the clean upstream compatibility baseline.
- Focused EXODIA branding and Italian rendering tests: ten passed. Onboarding gate tests: five passed.
- Locale parity and literal translation keys: passed. The checker test suite has one ordering-only failure, also reproduced on the clean upstream baseline.
- Backend full suite: 14,777 passed, 63 pending, 22 failed before the final text-assertion correction. Twenty-one failures also reproduce on clean upstream (Windows paths/symlinks, snapshot/route lints, and logging harness checks). The one additional brand assertion was corrected; the final focused backend set passes, including email branding, friendly errors, storage validation, scopes and NUL sanitization. Both full runs report 89.91% function coverage against a 90% threshold. No coverage thresholds or tests were disabled.
- Local built login preview: EXODIA wordmark, product mark, background and blue accents verified visually. The local preview has no backend, so the authentication form cannot load there. No production login or company data was used.
- Existing brand/deployment assets were compared with the branded starting commit. No private environment or key files were added.

## Deployment boundary

This is a source sync, not a production upgrade. Coolify was read-only and reported `running:healthy` with the deployed commit still pinned to `208c6de99a588e84380781909d3f82f35aa083e9`. The deployment branch and its runtime configuration remain unchanged. No migration, restart, data-source connection or deployment was performed. The upstream baseline still needs Linux/integration validation before a production upgrade.

The small interface icon replacement is separate: Lucide is the recommended candidate; no icon library was replaced in this sync.
