"""Wispr Flow's official read-only meeting-context MCP server, with per-user OAuth."""
from app.agents.mcp.mcp_server_decorator import mcp_server
from app.agents.mcp.models import AuthHint, MCPAuthMode, MCPServerTemplate, MCPTransport


@mcp_server(
    MCPServerTemplate(
        type_id="wispr_flow",
        display_name="Wispr Flow",
        description="Search and read meeting notes, transcripts, scratchpad notes, and calendar context in Wispr Flow.",
        transport=MCPTransport.STREAMABLE_HTTP,
        default_auth_mode=MCPAuthMode.OAUTH,
        supported_auth_modes=[MCPAuthMode.OAUTH],
        default_url="https://api.wisprflow.ai/connect/mcp",
        # Live resource/issuer metadata advertises DCR and PKCE S256; OAuth re-discovers it at sign-in.
        authorization_url="https://mcp-auth.wisprflow.com/oauth2/authorize",
        token_url="https://mcp-auth.wisprflow.com/oauth2/token",
        default_scopes=["openid", "offline_access"],
        supports_dcr=True,
        documentation_url="https://github.com/Wispr-AI/wispr-flow-plugin#readme",
        auth_hint=AuthHint(
            label="Wispr Flow OAuth",
            help_text="Sign in with your Wispr Flow account. Meeting notes and transcripts require Notetaker Cloud Sync.",
        ),
        tags=["meetings", "transcripts", "notes", "calendar"],
    )
)
class WisprFlowMCPServer:
    """Marker class — see `mcp_template` for the registered catalog entry."""
