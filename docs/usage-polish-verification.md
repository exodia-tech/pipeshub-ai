# Usage dashboard and speech verification

Local verification, 13 November 2026. Base: fork main 5d9e8f80f. Related: EXO-1139.

## Implemented

- Shared UserAvatar and signed-in profile store for personal identity; no new identity API or client-authorized report scope.
- Existing DateRangePicker (fixed between, inclusive UTC boundaries), shared single-select FilterDropdown, Radix scope/interval controls, existing SettingsPageContainer/SettingsSection and HelpTooltip. Date explanations support keyboard focus and click. Primary scope controls retain the product's Radix selection semantics; filters use the same toolbar chips as Users.
- Call history, member breakdown and pricing reuse EntityDataTable; history uses EntityPagination including page-size changes and offset reset. Read-only tables omit selection controls; existing selectable tables retain their desktop/mobile behavior. Pricing actions reuse EntityRowActionMenu.
- Existing admin organization/all-users/services/member controls preserved. Personal API isolation unchanged.
- Shared radio options now expose their visible labels to assistive technology.
- Speech factory accounting for TTS/STT including native Gemini, multipart OpenAI, OpenRouter, Wispr and local Whisper. Counts and outcomes retained even without billable counters. Raw audio, text and transcripts never enter the ledger. HTTP collection does not duplicate the adapter event.
- Audio is not assigned generic text-token prices. Existing custom rates remain available when applicable; unknown/unpriced calls remain visible. No historical reconstruction or schema migration.

## Automated verification

- 155 Python tests passed: usage meter, ledger, usage API authorization; speech factories/adapters and HTTP route behavior. Includes real temporary SQLite persistence, member/service attribution, privacy, deduplication, native Gemini TTS/STT metadata, failures and safe unpriced speech behavior. Provider network/SDK boundaries use synthetic responses, with no paid calls.
- 30 frontend tests passed: usage dashboard/formatting plus shared avatar and calendar coverage, including named member selection and default personal identity.
- TypeScript no-emit check passed; locale parity and literal-key validation passed.
- Initial speech-route import failures were resolved by importing the annotation-only container under TYPE_CHECKING. Pytest's temporary directory was directed to the existing writable D:/CodexTemp. Final relevant run has no failures.

## Chrome verification

Real local Next.js interface, synthetic API fixtures only (Demo Member/Alice Example, demo organization and counters). Tested 390, 768 and 1440 pixel widths. No document horizontal overflow or client-side page exceptions. Open mobile calendar fits viewport; Escape dismisses overlays; operation filter lists speech types. Checked keyboard-focus help, calendar Apply, individual member selection and STT query parameters. The preview has no socket server: socket.io connection errors are fixture limitations, separate from page errors.

Screenshots:

- [Call history desktop](screenshots/usage-polish/history-1440.png)
- [Call history mobile](screenshots/usage-polish/history-390.png)
- [Personal desktop](screenshots/usage-polish/personal-1440.png)
- [Personal mobile](screenshots/usage-polish/personal-390.png)
- [Tablet](screenshots/usage-polish/personal-768.png)
- [Organization services](screenshots/usage-polish/organization-1440.png)
- [Mobile calendar](screenshots/usage-polish/calendar-390.png)
- [Mobile operation picker](screenshots/usage-polish/type-filter-390.png)
- [Selected member and speech filter](screenshots/usage-polish/member-speech-390.png)

## Limits

This is local verification, not a production verification or provider-invoice reconciliation. Browser-native Web Speech has no server-side provider telemetry. Provider billing units/audio modality rates need dedicated reconciliation before claiming exact audio costs; call counts and available token counters are recorded now. Budgets remain warnings. No company-source ingestion, re-indexing, credentials changes or deployment was performed as part of these checks.
