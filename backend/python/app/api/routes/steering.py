"""Authenticated user updates for active agent runs; no source permissions are changed."""

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from app.agents.agent_loop.cancellation.registry import RunOwner
from app.agents.agent_loop.cancellation.validation import validate_run_id
from app.agents.agent_loop.steering import SteeringInbox, get_steering_inbox
from app.api.middlewares.auth import deny_service_tokens, require_scopes
from app.config.constants.service import OAuthScopes

router = APIRouter()


class SteerRunRequest(BaseModel):
    runId: str
    _validate_run_id = field_validator("runId")(validate_run_id)
    conversationId: str = Field(min_length=1, max_length=100)
    messageId: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=8000)


async def steering_inbox_dependency() -> SteeringInbox:
    try:
        return get_steering_inbox()
    except Exception:
        raise HTTPException(503, "Live steering is unavailable; retry later") from None


@router.post(
    "/chat/steer",
    dependencies=[
        Depends(deny_service_tokens),
        Depends(
            require_scopes(OAuthScopes.CONVERSATION_CHAT, OAuthScopes.AGENT_EXECUTE)
        ),
    ],
)
async def steer_chat_stream(
    request: Request,
    body: SteerRunRequest,
    inbox: SteeringInbox = Depends(steering_inbox_dependency),
) -> dict[str, bool]:
    user = getattr(request.state, "user", {}) or {}
    if not user.get("userId") or not user.get("orgId"):
        raise HTTPException(401, "Authentication required")
    requester = RunOwner(
        user_id=user["userId"],
        org_id=user["orgId"],
        conversation_id=body.conversationId,
    )
    if not body.text.strip():
        raise HTTPException(400, "A non-empty update is required")
    try:
        outcome = await inbox.submit(body.runId, requester, body.messageId, body.text)
    except Exception:
        raise HTTPException(
            503, "The update could not be delivered; retry later"
        ) from None
    if outcome == "forbidden":
        raise HTTPException(403, "You do not own this run")
    if outcome == "full":
        raise HTTPException(429, "Too many updates for this run; wait for the answer")
    return {
        "queued": outcome in ("queued", "duplicate"),
        "duplicate": outcome == "duplicate",
    }
