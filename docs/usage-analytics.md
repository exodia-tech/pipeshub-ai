# Usage and costs

Open **Workspace → Usage & costs**. Everyone can see their own model activity. An organization administrator can select **Organization** to compare members, background services, connectors, providers, models, workloads and operation types. Use the date and interval controls for hourly, daily, weekly or monthly charts. Dates use UTC; the selected end date is included. Reports cover up to 366 days, or 31 days for hourly charts. Request history is paginated; breakdowns return the 100 most active groups.

The overview shows model calls, input/output tokens, cache reads/writes, reasoning tokens, estimated USD spend and unpriced calls. Charts can rank activity by tokens, estimated spend or call count. Quiet time buckets are included. The table below each time chart provides an accessible alternative to the graphic.

## What is measured

The durable ledger is independent of an agent's optional `run_usage` streaming frame. Each logical model operation produces an event with a UUID, UTC timestamp, verified organization, person (when interactive), connector/agent/request IDs, provider/model, workload/purpose, counters, duration, status and price snapshot. An embedding batch is one operation with an item count; it may make several provider HTTP requests. The ledger contains no prompts, generated answers, source text, images, audio, provider keys or authentication tokens. There is no public event-ingestion API.

| Path | Accounting |
| --- | --- |
| Shared chat model factory | LangChain end/error callbacks, including non-agent helpers, extraction, classification and image descriptions |
| Agent transports | Direct SDK and LangChain complete/structured/stream calls, including helper agents and compaction; nested callbacks are suppressed to avoid double counting |
| Dense text embeddings | Provider response counters when available, including OpenAI-compatible/local server counters, Voyage total-token counters and Cohere billed units; batches retain connector context |
| Image embeddings | Operations and available provider counters; token usage stays unknown when an SDK discards its counters |
| Media clients | Speech/image responses through the shared HTTP client; binary audio is never buffered for accounting, so unavailable token usage remains unknown |
| Decision models | The shared decision client records its returned usage |
| Connector synchronization | Downstream extraction/classification/embedding calls carry the existing signed background context and connector ID; ordinary Drive/Slack HTTP requests are not model tokens |

Background work belongs to its organization and connector, not to the person who installed a connector. Startup embedding and entity-store probes are organization overhead when the authoritative graph contains exactly one organization; shared probes on a multi-organization installation remain unattributed rather than being assigned arbitrarily. Service-account agents retain their agent identity. Personal query embeddings belong to the requesting person. Calls without a verified organization are not assigned to an arbitrary tenant; they increment an attribution-gap diagnostic.

**Reported**, **estimated** and **not reported** are distinct. Text embeddings without provider counters use a marked `ceil(characters / 4)` estimate per text. Image/audio token counts are never guessed. Failed or cancelled operations can have unknown billed usage; failed network requests without a response in the media HTTP hook cannot be reconstructed. Custom integrations that bypass the shared factories/transports must add the same accounting hook. Accounting errors preserve the model operation and produce error logs and per-process diagnostics; the query dashboard cannot claim visibility into failures of another service process.

No historical usage is fabricated. Tracking starts when the environment flag is enabled. Existing invoices, historical chat transcripts, and historical connector activity are not imported or re-indexed.

LangChain transports resolve an omitted model name from the configured chat model before emitting usage. Older events with an empty model name remain unpriced: their exact model cannot be recovered from token counts. Failed calls without a provider usage response remain recorded with unknown counters; this is different from a dropped event. An unpriced event can also retain a historical missing-price snapshot even after a catalog fix, since price changes do not rewrite history.

## Cost estimates and pricing

Prices come from the installed LiteLLM package's [local fallback catalog](https://github.com/BerriAI/litellm/blob/main/litellm/model_prices_and_context_window_backup.json), read without importing LiteLLM or making a network request. It is a package-version snapshot, not a live price feed. An exact model entry or provider/model entry is required; Gemini resource names beginning with `models/` are matched to their catalog model, preferring the Gemini-specific price. Missing, invalid or tiered/threshold pricing stays unpriced. There are no invented exchange rates or guessed custom-model prices.

An administrator can set actual **USD per million tokens** rates for input, output, cache reads and cache writes. Use **Use catalog** to remove an override. Changes affect future calls only; each existing event retains its rate and cost snapshot. Cache tokens are subsets of input tokens; reasoning is a subset of output tokens, so neither is charged twice. Costs are stored as integer nanodollars. A zero price must be explicit; it means no provider charge and excludes hosting/infrastructure costs. The dashboard excludes unpriced calls from spend totals and keeps the missing-price count visible. When every call is unpriced, cost is shown as unknown in cards, tables and charts; timeline gaps are not plotted as zero. Reasoning tokens remain unknown when a provider or transport omits that breakdown, including aggregates containing any missing breakdown; output totals still include them. Agent transports currently default absent input/output counters to zero, so zero-sided agent calls conservatively stay unpriced even when a provider genuinely returned zero.

These are operational estimates, not provider invoices. Provider-specific discounts, cache-write duration tiers, region-specific rates, non-token units and failed/abandoned requests can require reconciliation with the provider. Set custom rates to the applicable contract rather than assuming a catalog entry matches it.

## Monthly budgets — initial version

Administrators can set warning budgets for the organization, a member, a connector or a model. A model budget includes all providers using that exact model ID. Budgets roll over on the first day of each UTC calendar month and default to an 80% warning threshold. Historical usage remains intact. Members can read only their own member budgets. Budget configuration is managed in Organization view; administrators can open it from the Budgets tab in Personal view. Member, connector and model targets are drawn from the current usage report, so a target without recorded usage in the selected date range cannot yet be selected.

Warnings and progress appear in this dashboard. **This version does not block model calls or send Slack/email alerts.** Unpriced activity triggers a warning and can understate budget progress. Positive budgets must be at least one nanodollar, the accounting precision. Hard enforcement needs a separate priced reservation/concurrency policy and explicit handling for unavailable accounting; it must not silently stop indexing on a price-catalog miss.

## Storage and deployment

EXODIA's single-host Compose deployment sets:

```text
PIPESHUB_USAGE_DB=/data/pipeshub/usage.sqlite3
```

Every Python service in the all-in-one application shares this existing persistent local volume. SQLite uses WAL, full synchronization, bounded lock waits and a primary event ID for deduplication. A fresh process reopens the same ledger. The app does not write usage into Redis, telemetry labels or an ephemeral container directory.

For a from-source or split-service deployment, set the same variable and mount the same **local** persistent directory into every participating process. Without the variable, collectors are disabled and the reporting API returns a setup error. This implementation is for one host: do not put WAL on a network filesystem or deploy independent replicas with isolated local ledgers. Move the sink to a central database before distributing these services across hosts.

The named volume is **not a backup**. Back up the SQLite database with its online backup API (or stop writers and copy the database and WAL consistently) as part of the eventual backup policy. Backup destination and restore testing remain tracked by EXO-461; this feature does not complete that work. Never commit a live ledger to Git.

## Access and verification

Node proxies `/api/v1/usage`, `/rates` and `/budgets` to the query service. Both layers enforce credential scopes. Python uses the verified caller's organization and forces personal reports to that caller's user ID, even if another `user_id` was supplied. Organization reports, prices and budget mutations use the existing authoritative administrator check. Scoped service tokens cannot read this API. OAuth/PAT access needs `org:read` for reports/budgets, `config:read` for custom prices, and `config:write` plus administrator status for changes.

The OpenAPI document describes the routes. Tests exercise real SQLite writes, parallel writers, restarts, tenant isolation, price snapshots, token subsets, budget resets, provider callbacks, nested-agent deduplication, response privacy, cancelled streams and route-level visibility/scope rules. Frontend checks cover cost/date formatting and dashboard behavior. Live validation should confirm the deployed commit, API privacy, application health, the mounted ledger, and one ordinary authorized model operation; it must not ingest new company sources or trigger re-indexing just to populate charts.
