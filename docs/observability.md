# Usage observability

EXODIA Brain can optionally send the usage ledger's model events to Langfuse or an OTLP/HTTP trace collector. This is disabled by default. It exports model, provider, token counts, recorded cost and timing; it does not export prompts, responses, documents, user identifiers or conversation traces. Each model event is an independent trace. Only calls already covered by the usage ledger are included, and events without a verified organization are excluded. This does not replace the ledger or the existing Opik integration.

To enable it, first enable the usage ledger with `PIPESHUB_USAGE_DB` and provision its persistent storage. Set these variables on each Python service that records usage, then restart those services:

| Variable | Value |
| --- | --- |
| `EXODIA_OTLP_ENABLED` | `true` |
| `EXODIA_OTLP_ORG_ID` | The exact verified organization ID whose events may be exported. Other organizations are excluded. |
| `EXODIA_OTLP_ENDPOINT` | The complete HTTPS OTLP traces endpoint, without credentials, query parameters or a fragment. For Langfuse this is `https://<langfuse-host>/api/public/otel/v1/traces`. HTTP is permitted only for loopback testing. |
| `EXODIA_OTLP_HEADERS` | JSON object containing authentication headers. Store this as a secret in the deployment environment, never in source control. |

For Langfuse, create a Langfuse API key and set the `Authorization` header to `Basic ` followed by the Base64 encoding of `<public key>:<secret key>`. Add `x-langfuse-ingestion-version` with value `4`. Use the hostname for your Langfuse region or self-hosted installation. See [Langfuse's OpenTelemetry documentation](https://langfuse.com/integrations/native/opentelemetry) and [token and cost tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking).

For example, the secret header variable has the shape `{"Authorization":"Basic <encoded credentials>","x-langfuse-ingestion-version":"4"}`. Do not use the literal placeholder as a credential. The EXODIA Compose service passes these variables through; other deployments need to pass them to their Python services explicitly.

Only successfully committed, newly inserted ledger events are queued. Export is asynchronous, bounded, and best effort: collector failures, queue overflow and shutdown can lose traces, so the local ledger remains the accounting source. Unknown token counts and costs are omitted rather than reported as zero; Langfuse may infer its own prices for unpriced events, which can differ from the ledger. Restart services after changing the configuration. No destination is contacted until configured and enabled.
