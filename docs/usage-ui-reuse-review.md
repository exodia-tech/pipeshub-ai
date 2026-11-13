# Usage UI reuse review — 13 November 2026

Follow-up to EXO-1139 and PR #64, based on main 8e6136a. The previous pass replaced the tables, but it did not fully reconcile the surrounding surfaces and controls.

## Findings and changes

| Area | Finding | Existing frontend implementation reused |
| --- | --- | --- |
| Cards, chart panels, filter section | Shared SettingsSection used the 4px corner token, making every caller look square despite the rounded theme. | Update SettingsSection once to the existing 12px surface token. General settings and Usage inherit the same change. |
| Filter popups | FilterDropdown outer popup used the 4px token, unlike its 8px trigger/calendar. | Keep FilterDropdown and change only its outer popup to the 8px control token. Option rows retain their smaller internal radius. |
| Calendar clear action | The separate clear button had square exposed right corners on hover/focus. | Fix the right corners inside DateRangePicker, preserving its segmented edge and touch/focus area. |
| Required scope/interval controls | Default Radix size-2 typography mixed with size-1 filter chips forced to 28px height. | Use Radix Select size 1 on the root with the same 28px/8px trigger sizing; keep built-in selection and keyboard behavior. |
| Filters toggle and chart metric | Default button/selector size and corners did not match adjacent compact controls. | Existing Radix controls, matching compact size and token-based corners. |
| Call-history frame | The shared table sat in a page wrapper with the small corner token. | Keep EntityDataTable/EntityPagination; match the wrapper to the shared 12px surface. |
| Model pricing | Provider/model inputs had a separate hand-written background, border, font and sizing object. | Remove that object and use TextField.Root, preserving native datalist suggestions, validation and change handlers. |
| Budget fields | Compact toolbar sizing had leaked into form selectors. | Restore standard Radix field sizing alongside existing TextField fields. |

No new component, dependency, wrapper or feature was introduced. Header/layout remain SettingsPageContainer and the settings-page Radix pattern used by General; visual tables remain EntityDataTable, history pagination EntityPagination, pricing actions EntityRowActionMenu, member identity UserAvatar, and help HelpTooltip. Required scope selectors remain Radix Select; optional removable filters remain FilterDropdown. This preserves their distinct selection/clear behavior while matching their toolbar size.

## Verification

- TypeScript no-emit check passed.
- 34 tests passed across the Usage page/formatting, shared table desktop/mobile selection and read-only behavior, responsive settings components, settings page container and calendar interactions.
- Real local Chrome with synthetic Demo Member/Alice Example and dummy usage counters; no company content or paid provider calls.
- Light and dark modes at 375, 390, 768, 1440 and 1920px. No document overflow or client-side page exceptions.
- Computed compact scope controls: 28px height, 12px font, 8px corners. Filter popup: 8px corners, entirely inside a 390px viewport.
- Applied dates, selected a member and Speech-to-text filter, verified query parameters, keyboard-focus help and Escape dismissal. Checked pricing inputs retain editable values and compared General settings using the same shared section.
- Fixture preview has no notification socket server; socket errors are separate from the page-error check.

## Screenshots

All screenshots are local synthetic fixtures, not production evidence.

- [Usage, dark desktop](screenshots/usage-surfaces/dark-1440.png)
- [Usage, dark mobile](screenshots/usage-surfaces/dark-390.png)
- [Usage, light desktop](screenshots/usage-surfaces/light-1440.png)
- [Usage, light mobile](screenshots/usage-surfaces/light-390.png)
- [Open filter, dark mobile](screenshots/usage-surfaces/dark-filter-390.png)
- [Selected member/operation filters](screenshots/usage-surfaces/selected-filters-390.png)
- [History footer, dark mobile](screenshots/usage-surfaces/dark-history-390.png)
- [Standard pricing inputs](screenshots/usage-surfaces/dark-pricing-1440.png)
- [General settings reference](screenshots/usage-surfaces/dark-general-1440.png)

## Scope and limits

The SettingsSection, filter popup and calendar corner changes affect their existing callers. General settings was checked to confirm that shared effect; not every settings screen was exercised. No data model, auth, accounting, pricing behavior or backend code changed. Production deployment is not verified by these local checks.
