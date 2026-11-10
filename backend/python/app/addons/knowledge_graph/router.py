import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.addons.knowledge_graph.service import GraphOverviewError, graph_page
from app.api.middlewares.auth import connection_limit, require_scopes
from app.config.constants.service import OAuthScopes
from app.services.featureflag.platform_settings import is_named_entity_extraction_enabled
from app.services.graph_db.interface.graph_db_provider import IGraphDBProvider

logger = logging.getLogger(__name__)


class GraphOverviewQuery(BaseModel):
    cursor: str | None = Field(default=None, min_length=1, max_length=16384)


def create_router(
    *, identity: Callable[[Request], tuple[str, str]],
    provider: Callable[[Request], Awaitable[IGraphDBProvider]],
) -> APIRouter:
    router = APIRouter(tags=["Knowledge Graph add-on"])

    @router.post("/search/graph", dependencies=[Depends(require_scopes(OAuthScopes.SEMANTIC_READ, OAuthScopes.SEMANTIC_WRITE))])
    async def overview(request: Request, body: GraphOverviewQuery, graph_provider: IGraphDBProvider = Depends(provider)) -> JSONResponse:
        from app.connectors.sources.localKB.handlers.knowledge_hub_service import KnowledgeHubService

        org_id, user_id = identity(request)
        config = request.app.container.config_service()
        try:
            graph = await graph_page(
                graph_provider, KnowledgeHubService(logger, graph_provider, config),
                user_id=user_id, org_id=org_id, cursor=body.cursor,
                source_limited=connection_limit(request.state.user) is not None,
                named_enabled=await is_named_entity_extraction_enabled(config),
            )
        except GraphOverviewError as exc:
            raise HTTPException(status_code=exc.status_code, detail=str(exc)) from exc
        except Exception as exc:
            logger.warning("graph add-on lookup failed", exc_info=True)
            raise HTTPException(status_code=503, detail="Graph lookup failed - try again.") from exc
        return JSONResponse(content=graph)

    return router
