# Wispr Flow meeting connection

Wispr Flow is available in the MCP server catalog. It uses the [official remote MCP server](https://github.com/Wispr-AI/wispr-flow-plugin#readme) at `https://api.wisprflow.ai/connect/mcp` with per-user OAuth. No API key or desktop dictation SDK is required.

## Connect

1. Open **Workspace → Your MCP servers**, add a server, and choose **Wispr Flow**. A personal instance keeps the connection scoped to you. Administrators can also offer an organization instance; use per-user sign-in for meeting data rather than shared credentials.
2. Save the server, choose **Connect**, and complete Wispr's consent screen. The existing MCP OAuth flow discovers the provider, registers the client when supported, and uses PKCE. Credentials use the existing encrypted MCP credential store.
3. Discover the tools and select the server in your agent's MCP configuration. Only tools returned by the authenticated server are offered; their names and schemas are not hard-coded here.

Try asking: “Summarize my last meeting and list the decisions and action items.” Existing MCP tool permissions and agent access rules still apply.

## Requirements and limits

- Meeting notes and transcripts require **Notetaker with Cloud Sync enabled**.
- Enterprise administrators must enable the Wispr Flow MCP connector. Scratchpad tools also require Scratchpad access. HIPAA-covered accounts are unsupported.
- Wispr documents this MCP server as read-only: meetings, transcripts, scratchpad notes, calendar events and supported shared notes. This connection does not add dictation-history access or chat speech recognition.
- Tools retrieve context on demand. This feature adds no indexing connector, background ingestion or shared collection synchronization.
- Consent and authenticated discovery must be completed by the account owner. Anonymous metadata checks do not prove that a particular account or deployment redirect URI will be accepted.

Source: [Wispr Flow's official requirements and capabilities](https://github.com/Wispr-AI/wispr-flow-plugin/blob/main/README.md).

## Provider verification and upstream research

Checked 2026-11-08 without accessing meeting data, registering a client or exchanging tokens. Anonymous initialization returns HTTP 401 with OAuth discovery metadata. GET on the MCP endpoint returns 405 (POST-only), which does not indicate an unhealthy server.

The [protected-resource metadata](https://api.wisprflow.ai/.well-known/oauth-protected-resource) requests `openid offline_access` and identifies `https://mcp-auth.wisprflow.com` as the issuer. Its [authorization-server metadata](https://mcp-auth.wisprflow.com/.well-known/oauth-authorization-server) advertises `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register`, PKCE S256 and refresh tokens. Template defaults are UI hints; the existing authorization flow re-discovers live metadata.

All-state issue/PR searches in `pipeshub-ai/pipeshub-ai` found no request or implementation for the Wispr Flow meeting MCP connection. Exact searches for `"wispr flow"`, `"wispr-flow"`, `wisprflow` and `"whisper flow"` returned zero results. The broader `wispr` search returned three merged PRs, all for different work:

- [#2039](https://github.com/pipeshub-ai/pipeshub-ai/pull/2039): connector select/drawer UI fix.
- [#2245](https://github.com/pipeshub-ai/pipeshub-ai/pull/2245): Gemini and Wispr speech-provider fixes.
- [#3892](https://github.com/pipeshub-ai/pipeshub-ai/pull/3892): model endpoint connection security.

[Search evidence](https://github.com/pipeshub-ai/pipeshub-ai/issues?q=wispr). Search results can miss requests described with other wording. Existing Wispr speech-provider support is separate from this meeting-context integration.
