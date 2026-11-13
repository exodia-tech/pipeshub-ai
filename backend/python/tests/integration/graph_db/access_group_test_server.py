"""Loopback-only synthetic integration server; never points at a non-test graph."""

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import PlainTextResponse

from app.api.middlewares.auth import authMiddleware, require_service_token
from app.api.routes.entity import router
from app.config.constants.service import TokenScopes
from app.services.graph_db.neo4j.neo4j_provider import Neo4jProvider

logging.getLogger("neo4j.notifications").setLevel(logging.ERROR)

if os.environ.get("EXODIA_TEST_NEO4J") != "bolt://127.0.0.1:52413":
    raise RuntimeError("This test server requires the isolated EXODIA graph container")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    os.environ["NEO4J_URI"] = "bolt://127.0.0.1:52413"
    os.environ["NEO4J_USERNAME"] = "neo4j"
    os.environ["NEO4J_PASSWORD"] = "localtestpass"
    graph = Neo4jProvider(logging.getLogger(__name__), config)
    if not await graph.connect():
        raise RuntimeError("Test graph unavailable")
    app.state.graph_provider = graph
    yield
    await graph.disconnect()


app = FastAPI(lifespan=lifespan)
app.container = MagicMock()
config = AsyncMock()
config.get_config.return_value = {
    "jwtSecret": "local-regular-secret-not-used-for-services",
    "scopedJwtSecret": "local-only-test-secret-with-enough-length",
}
app.container.config_service.return_value = config
app.container.logger.return_value = logging.getLogger(__name__)
app.include_router(router, dependencies=[Depends(authMiddleware)])

FIXTURE_TEXT = {
    "demo-finance-record": "Finance update: a synthetic quarterly budget review is scheduled.",
    "demo-general-record": "General update: the synthetic team meeting is on Friday.",
    "demo-private-record": "LEADERSHIP_PRIVATE_CANARY",
    "demo-projects-record": "Projects update: the synthetic onboarding plan is ready.",
    "demo-hr-record": "HR_PRIVATE_CANARY",
    "demo-budget": "Budget Q4: a synthetic planning budget of EUR 10,000.",
}


@app.get(
    "/api/v1/stream/record/{record_id}",
    dependencies=[
        Depends(authMiddleware),
        Depends(require_service_token(TokenScopes.RECORD_CONTENT)),
    ],
)
async def fixture_stream(request: Request, record_id: str) -> PlainTextResponse:
    claims = request.state.user
    permission = await app.state.graph_provider.check_record_access_with_details(
        claims["userId"], claims["orgId"], record_id
    )
    if not permission or record_id not in FIXTURE_TEXT:
        raise HTTPException(status_code=404, detail="Record not found")
    return PlainTextResponse(
        FIXTURE_TEXT[record_id],
        headers={"content-disposition": 'inline; filename="fixture.txt"'},
    )


@app.post("/test/record-detail")
async def fixture_detail(request: Request) -> dict:
    _test_only(request)
    body = await request.json()
    graph = app.state.graph_provider
    permission = await graph.check_record_access_with_details(
        body["member"], body["org"], body["id"]
    )
    if not permission or body["id"] not in FIXTURE_TEXT:
        raise HTTPException(status_code=404, detail="Record not found")
    doc = await graph.get_document(body["id"], "records", raise_on_error=True)
    return {
        "record": {
            **doc,
            "id": body["id"],
            "recordName": doc.get("recordName"),
            "mimeType": "text/plain",
            "recordType": "FILE",
            "origin": "CONNECTOR",
            "hideWeburl": True,
            "previewRenderable": True,
            "webUrl": "",
            "version": 0,
            "sizeInBytes": len(FIXTURE_TEXT[body["id"]].encode()),
            "fileRecord": {
                "name": doc.get("recordName"),
                "isFile": True,
                "extension": "txt",
                "mimeType": "text/plain",
            },
        },
        "knowledgeBase": None,
        "folder": None,
        "metadata": {
            "departments": [],
            "categories": [],
            "topics": [],
            "languages": [],
            "permissions": [],
        },
        "permissions": {
            "role": "READER",
            "canEdit": False,
            "canDelete": False,
            "canUpload": False,
            "canManagePermissions": False,
        },
    }


@app.post("/test/demo")
async def demo(request: Request) -> dict:
    _test_only(request)
    graph = app.state.graph_provider
    # Fixed ids make this seed repeatable; only the disposable local graph is reachable.
    org = "611111111111111111111111"
    admin = "622222222222222222222222"
    member = "633333333333333333333333"
    group = "8dbe044a-f322-44bd-9111-ae1d75eb6597"
    await graph.client.execute_query(
        """
        MERGE (a:User {id:$admin}) SET a.userId=$admin, a.orgId=$org, a.fullName='Alex Example', a.email='alex@example.invalid', a.isActive=true
        MERGE (u:User {id:$member}) SET u.userId=$member, u.orgId=$org, u.fullName='Sam Example', u.email='sam@example.invalid', u.isActive=true
        MERGE (g:Teams {id:$group}) SET g.orgId=$org, g.name='Finance', g.exodiaAccessGroup=true, g.createdBy=$admin,
          g.description=coalesce(g.description,'Finance reference material and shared reports'),
          g.createdAtTimestamp=coalesce(g.createdAtTimestamp,1794528000000)
        MERGE (u)-[:PERMISSION {type:'USER', role:'READER'}]->(g)
        WITH a,u,g
        UNWIND [{id:'demo-slack',name:'Slack workspace',type:'SLACK WORKSPACE'}, {id:'demo-drive',name:'Google Drive',type:'GOOGLE DRIVE'}] AS source
        MERGE (app:App {id:source.id}) SET app.orgId=$org, app.name=source.name, app.type=source.type, app.permissionModel='RECORD_GROUP_LEVEL'
        MERGE (a)-[:PERMISSION {type:'USER', role:'READER'}]->(app)
        MERGE (u)-[:PERMISSION {type:'USER', role:'READER'}]->(app)
        WITH a,u
        UNWIND [{id:'demo-finance',name:'#finance',app:'demo-slack',shared:true}, {id:'demo-general',name:'#general',app:'demo-slack',shared:true}, {id:'demo-private',name:'#leadership-private',app:'demo-slack',shared:false}, {id:'demo-projects',name:'Projects',app:'demo-drive',shared:true}, {id:'demo-hr',name:'HR confidential',app:'demo-drive',shared:false}] AS folder
        MATCH (app:App {id:folder.app})
        MERGE (rg:RecordGroup {id:folder.id}) SET rg.orgId=$org, rg.groupName=folder.name, rg.connectorId=folder.app, rg.accessRule='OPEN', rg.permissionModel='RECORD_GROUP_LEVEL'
        MERGE (rg)-[:BELONGS_TO]->(app)
        MERGE (app)-[:NODE_RELATION {relationshipType:'PARENT_CHILD'}]->(rg)
        MERGE (a)-[:PERMISSION {type:'USER',role:'READER'}]->(rg)
        FOREACH (_ IN CASE WHEN folder.shared THEN [1] ELSE [] END | MERGE (u)-[:PERMISSION {type:'USER',role:'READER'}]->(rg))
        WITH rg,folder
        MERGE (r:Record {id:folder.id+'-record'}) SET r.orgId=$org, r.recordName=folder.name+' — sample notes.txt', r.connectorId=folder.app, r.virtualRecordId=folder.id+'-virtual', r.recordType='FILE', r.mimeType='text/plain', r.indexingStatus='COMPLETED', r.accessRule='OPEN'
        MERGE (r)-[:BELONGS_TO]->(rg)
        MERGE (rg)-[:NODE_RELATION {relationshipType:'PARENT_CHILD'}]->(r)
        MERGE (r)-[:INHERIT_PERMISSIONS]->(rg)
    """,
        parameters={"org": org, "admin": admin, "member": member, "group": group},
    )
    await graph.client.execute_query(
        """
        MATCH (project:RecordGroup {id:'demo-projects'})
        MERGE (folder:Record {id:'demo-documents'}) SET folder.orgId=$org,folder.recordName='Documents',folder.recordType='FILE',folder.mimeType='application/vnd.folder',folder.connectorId='demo-drive',folder.accessRule='OPEN'
        MERGE (file:Record {id:'demo-budget'}) SET file.orgId=$org,file.recordName='Budget Q4.txt',file.recordType='FILE',file.mimeType='text/plain',file.connectorId='demo-drive',file.virtualRecordId='demo-budget-virtual',file.indexingStatus='COMPLETED',file.accessRule='OPEN'
        MERGE (project)-[:NODE_RELATION {relationshipType:'PARENT_CHILD'}]->(folder)
        MERGE (folder)-[:BELONGS_TO]->(project)
        MERGE (folder)-[:INHERIT_PERMISSIONS]->(project)
        MERGE (folder)-[:NODE_RELATION {relationshipType:'PARENT_CHILD'}]->(file)
        MERGE (file)-[:BELONGS_TO]->(project)
        MERGE (file)-[:INHERIT_PERMISSIONS]->(folder)
    """,
        parameters={"org": org},
    )
    return {
        "org": org,
        "admin": admin,
        "member": member,
        "group": group,
        "fixtureVersion": "nested-v2",
    }


@app.post("/test/authorized-records")
async def authorized_records(request: Request) -> dict:
    _test_only(request)
    body = await request.json()
    graph = app.state.graph_provider
    ids = [
        "demo-finance-record",
        "demo-general-record",
        "demo-private-record",
        "demo-projects-record",
        "demo-hr-record",
        "demo-budget",
    ]
    decision = await graph.check_access(
        body["member"],
        body["org"],
        node_ids=ids,
        virtual_record_ids=[key.removesuffix("-record") + "-virtual" for key in ids],
        indexed_only=True,
    )
    return {
        "records": sorted(decision.node_ids),
        "searchRecords": sorted(decision.records_by_vrid.values()),
    }


@app.post("/test/chat-context")
async def chat_context(request: Request) -> dict:
    _test_only(request)
    from app.modules.retrieval.retrieval_service import RetrievalService

    body = await request.json()
    ids = ["demo-finance", "demo-general", "demo-private", "demo-projects", "demo-hr"]
    mapping = {key + "-virtual": key + "-record" for key in ids}
    mapping["demo-budget-virtual"] = "demo-budget"
    hits = [{"metadata": {"virtualRecordId": key + "-virtual"}} for key in ids]
    hits.append({"metadata": {"virtualRecordId": "demo-budget-virtual"}})
    # This is the actual RAG post-retrieval gate, fed deliberately over-broad synthetic hits.
    readable = await RetrievalService._keep_permitted_hits(
        SimpleNamespace(graph_provider=app.state.graph_provider),
        hits,
        mapping,
        body["member"],
        body["org"],
    )
    return {"contextRecordIds": sorted(readable.values())}


@app.post("/api/v1/chat/records/access", dependencies=[Depends(authMiddleware)])
async def history_access(
    request: Request,
    claims=Depends(require_service_token(TokenScopes.CONVERSATION_PERMISSIONS)),
) -> dict:
    from app.services.group_resource_policy import GroupResourceAccess

    body = await request.json()
    org, user = claims["orgId"], claims["userId"]
    graph = app.state.graph_provider
    decision = await graph.check_access(user, org, node_ids=body.get("recordIds", []))
    return {
        "accessible": sorted(decision.node_ids),
        "accessibleUrls": [],
        "groupRestricted": await GroupResourceAccess(graph).user_has_restrictions(
            org, user
        ),
    }


@app.post("/test/browse")
async def browse(request: Request) -> dict:
    _test_only(request)
    from app.connectors.sources.localKB.handlers.knowledge_hub_service import (
        KnowledgeHubService,
    )

    body = await request.json()
    service = KnowledgeHubService(
        logging.getLogger(__name__), app.state.graph_provider, config
    )
    result = await service.get_nodes(
        body["member"],
        body["org"],
        parent_id=body.get("parent"),
        parent_type=body.get("type"),
        flattened=body.get("flattened", False),
        q=body.get("q"),
        limit=body.get("limit", 50),
        cursor=body.get("cursor"),
        sort_by="name",
        sort_order="asc",
        include=["counts", "availableFilters", "breadcrumbs"],
    )
    return result.model_dump(mode="json")


def _test_only(request: Request) -> None:
    if request.headers.get("x-exodia-test") != "local-synthetic-only":
        raise HTTPException(status_code=403)


@app.get("/test/health")
async def health(request: Request) -> dict:
    _test_only(request)
    await app.state.graph_provider.client.execute_query("RETURN 1 AS ready")
    return {"status": "healthy"}


@app.post("/test/seed")
async def seed(request: Request) -> dict:
    _test_only(request)
    body = await request.json()
    await app.state.graph_provider.client.execute_query(
        """CREATE (:User {id:$admin, userId:$admin, orgId:$org, isActive:true})
        CREATE (:User {id:$member, userId:$member, orgId:$org, isActive:true})
        CREATE (:User {id:$foreign, userId:$foreign, orgId:$foreignOrg, isActive:true})
        CREATE (:App {id:$kb, orgId:$org, type:'KB', name:'Synthetic collection'})""",
        parameters=body,
    )
    return {"ok": True}


@app.post("/test/share")
async def share(request: Request) -> dict:
    _test_only(request)
    body = await request.json()
    return await app.state.graph_provider.create_kb_permissions(
        body["kb"], body["admin"], [], [body["group"]], "READER"
    )


@app.post("/test/access")
async def access(request: Request) -> dict:
    _test_only(request)
    body = await request.json()
    rows, _, _ = await app.state.graph_provider.list_user_knowledge_bases(
        body["member"], body["org"], 0, 100
    )
    return {"ids": [row["id"] for row in rows]}


@app.post("/test/cleanup")
async def cleanup(request: Request) -> dict:
    _test_only(request)
    body = await request.json()
    await app.state.graph_provider.client.execute_query(
        "MATCH (n) WHERE n.id IN $ids DETACH DELETE n", parameters={"ids": body["ids"]}
    )
    return {"ok": True}
