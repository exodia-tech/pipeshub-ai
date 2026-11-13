import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException

from app.agents.agent_loop.cancellation.registry import RunOwner


def request(body, user=None) -> MagicMock:
    req = MagicMock()
    req.json = AsyncMock(return_value=body)
    req.state.user = user if user is not None else {"userId": "alice", "orgId": "org-a"}
    return req


@pytest.mark.asyncio
async def test_steering_uses_verified_identity_not_body_claims() -> None:
    from app.api.routes.steering import SteerRunRequest, steer_chat_stream

    body = {
        "runId": str(uuid.uuid4()),
        "conversationId": "chat-a",
        "messageId": "1.1",
        "text": "Only AI",
        "userId": "bob",
    }
    inbox = MagicMock(submit=AsyncMock(return_value="queued"))
    assert await steer_chat_stream(request(body), SteerRunRequest(**body), inbox) == {
        "queued": True,
        "duplicate": False,
    }
    assert inbox.submit.call_args.args[1] == RunOwner(
        user_id="alice", org_id="org-a", conversation_id="chat-a"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome,code", [("forbidden", 403), ("full", 429)])
async def test_steering_route_rejects_unauthorized_or_overfull_updates(
    outcome, code
) -> None:
    from app.api.routes.steering import SteerRunRequest, steer_chat_stream

    body = {
        "runId": str(uuid.uuid4()),
        "conversationId": "chat-a",
        "messageId": "1.1",
        "text": "Only AI",
    }
    with pytest.raises(HTTPException) as error:
        await steer_chat_stream(
            request(body),
            SteerRunRequest(**body),
            MagicMock(submit=AsyncMock(return_value=outcome)),
        )
    assert error.value.status_code == code


@pytest.mark.asyncio
async def test_finished_and_duplicate_acknowledgements_are_distinct() -> None:
    from app.api.routes.steering import SteerRunRequest, steer_chat_stream

    body = {
        "runId": str(uuid.uuid4()),
        "conversationId": "chat-a",
        "messageId": "1.1",
        "text": "Only AI",
    }
    assert await steer_chat_stream(
        request(body),
        SteerRunRequest(**body),
        MagicMock(submit=AsyncMock(return_value="finished")),
    ) == {"queued": False, "duplicate": False}
    assert await steer_chat_stream(
        request(body),
        SteerRunRequest(**body),
        MagicMock(submit=AsyncMock(return_value="duplicate")),
    ) == {"queued": True, "duplicate": True}
