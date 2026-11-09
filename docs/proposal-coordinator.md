# Proposal coordinator rules

These are offline rules and synthetic tests for EXO-1094. They do not register
an agent, access Slack or Linear, persist state, or schedule or send reminders.
The shared authorized runtime remains a prerequisite before live operation.

The adapter must check a caller's current project, channel and source ACLs
before passing any source text into `capture_candidate`. The boolean arguments
in this module are decisions supplied by that trusted adapter, not an
authentication mechanism. Review every candidate with a human: phrase matching
is intentionally conservative and is not reliable proof of a commitment. It
cannot infer a client, accountable owner, source permissions, or deadline.

Use `(workspace, channel, message)` as the source identity. Atomically persist
one confirmed case per source identity and reconcile ambiguous cross-message
duplicates with a human. Record the source revision; edits/deletion pause
reminders until a person confirms the change. Persist original commitment,
owner, client scope, exact deadline and timezone, and any explicit manual
override. Seven calendar days preserves the commitment's local time; a deadline
in a DST gap or overlap requires a human-selected time. Linear shows a date,
so preserve the exact time and zone in the case and issue description as well.

After confirmation, the runtime must discover or create one linked issue with
the appropriate write authorization and protect human edits. Current Linear
agent action definitions expose `create_issue` and `update_issue`, but their
parameters do not include a due date or project ID. The Linear MCP template is
OAuth with read/write scopes; the existing read-only sync connector does not
establish permission to write. Check the actual authorized action schema and
permissions before choosing a write path. Do not silently fall back to a broad
token or publish client material to a wider issue/channel audience.

The runtime must revalidate access to the Slack source, issue, discovery notes,
proposal document and delivery destination on every run. Choose approved
working hours and weekdays explicitly. Missed reminder stages coalesce to the
latest due stage. A successful deadline reminder is followed by at most one
overdue escalation per business day, until verified sent or cancelled. Reserve
delivery atomically in persistent storage; an uncertain delivery blocks further
reminders until a human reconciles it. The in-memory dataclass alone is not a
distributed lock or deduplication store. Never retry an ambiguous Slack or
Linear write without reconciliation. A changed deadline creates a new reminder
revision and preserves the prior delivery record.

Client messages and proposals remain drafts for human review. No external
email, purchase, payment, fabricated pricing or silent deadline changes.
