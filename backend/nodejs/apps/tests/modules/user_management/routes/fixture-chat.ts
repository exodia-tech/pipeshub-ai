/** Deterministic local responder using the production RAG access gate; no model/provider calls. */
import { Router, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { AuthMiddleware } from '../../../../src/libs/middlewares/auth.middleware';
import { AuthenticatedUserRequest } from '../../../../src/libs/middlewares/types';
import { recordAuditEvent } from '../../../../src/modules/audit/audit.store';
import {
  redactMessagesFor,
  viewerOf,
} from '../../../../src/modules/enterprise_search/utils/viewer-redaction';
import type { AppConfig } from '../../../../src/modules/tokens_manager/config/config';

const modelInfo = {
  modelKey: 'local-fixture',
  modelName: 'local-fixture',
  modelFriendlyName: 'Local fixture responder · no external AI',
  chatMode: 'quick',
  modelProvider: 'fixture',
};
const content: Record<string, string> = {
  'demo-finance-record':
    'Finance update: a synthetic quarterly budget review is scheduled.',
  'demo-general-record':
    'General update: the synthetic team meeting is on Friday.',
  'demo-private-record': 'LEADERSHIP_PRIVATE_CANARY',
  'demo-projects-record':
    'Projects update: the synthetic onboarding plan is ready.',
  'demo-hr-record': 'HR_PRIVATE_CANARY',
  'demo-budget': 'Budget Q4: a synthetic planning budget of EUR 10,000.',
};
interface FixtureMessage {
  _id: string;
  messageType: string;
  content: string;
  contentFormat: string;
  citations: unknown[];
  followUpQuestions: string[];
  referenceData: unknown[];
  modelInfo: typeof modelInfo;
  createdAt: string;
  updatedAt: string;
  feedback: unknown[];
  sourceIds: string[];
}
interface FixtureConversation {
  _id: string;
  id: string;
  userId: string;
  orgId: string;
  initiator: string;
  title: string;
  messages: FixtureMessage[];
  createdAt: string;
  updatedAt: string;
  isShared: boolean;
  sharedWith: unknown[];
  status: string;
  modelInfo: typeof modelInfo;
  access: { isOwner: boolean; accessLevel: string };
}

export function fixtureChat(auth: AuthMiddleware, backend: string): Router {
  const router = Router();
  const conversations = new Map<string, FixtureConversation>();
  router.use(auth.authenticate);
  async function readable(req: AuthenticatedUserRequest): Promise<Set<string>> {
    const response = await fetch(`${backend}/test/chat-context`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-exodia-test': 'local-synthetic-only',
      },
      body: JSON.stringify({
        member: String(req.user!.userId),
        org: String(req.user!.orgId),
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error('Fixture retrieval gate unavailable');
    return new Set(
      ((await response.json()) as { contextRecordIds: string[] })
        .contextRecordIds,
    );
  }
  function owned(req: AuthenticatedUserRequest, id: string) {
    const conversation = conversations.get(id);
    return conversation?.userId === String(req.user!.userId) &&
      conversation.orgId === String(req.user!.orgId)
      ? conversation
      : null;
  }
  async function visible(conversation: FixtureConversation) {
    const messages = conversation.messages.map(({ sourceIds, ...message }) => ({
      ...message,
      citations: sourceIds.map((id) => ({
        citationData: { metadata: { recordId: id } },
      })),
    }));
    return {
      ...conversation,
      messages: await redactMessagesFor(
        {
          aiBackend: backend,
          jwtSecret: 'local-only-test-secret-with-enough-length',
          scopedJwtSecret: 'local-only-test-secret-with-enough-length',
        } as AppConfig,
        viewerOf(conversation.userId, conversation.orgId),
        messages,
        () => conversation.userId,
      ),
    };
  }
  router.get('/', (req: AuthenticatedUserRequest, res) =>
    res.json({
      conversations: [...conversations.values()]
        .filter(
          (row) =>
            row.userId === String(req.user!.userId) &&
            row.orgId === String(req.user!.orgId),
        )
        .map((row) => ({ ...row, messages: undefined })),
      pagination: { totalCount: conversations.size, hasNextPage: false },
    }),
  );
  router.get('/:id', async (req: AuthenticatedUserRequest, res, next) => {
    try {
      const row = owned(req, String(req.params.id));
      if (!row) {
        res.sendStatus(404);
        return;
      }
      const conversation = await visible(row);
      res.json({
        conversation,
        filters: {},
        meta: {},
        messages: conversation.messages,
        pagination: {
          page: 1,
          limit: 50,
          hasNextPage: false,
          totalCount: conversation.messages.length,
        },
      });
    } catch (error) {
      next(error);
    }
  });
  async function stream(
    req: AuthenticatedUserRequest,
    res: Response,
    next: NextFunction,
  ) {
    try {
      const query = req.body?.query;
      if (
        typeof query !== 'string' ||
        !query.trim() ||
        query.length > 5000 ||
        req.body.attachments?.length
      ) {
        res.status(400).json({
          error: 'The local fixture responder accepts text questions only.',
        });
        return;
      }
      let row = req.params.id ? owned(req, req.params.id) : null;
      if (req.params.id && !row) {
        res.sendStatus(404);
        return;
      }
      const allowed = await readable(req);
      const lower = query.toLowerCase();
      const sources = [...allowed].filter((id) =>
        lower.includes('finance')
          ? id.includes('finance')
          : lower.includes('budget') || lower.includes('document')
            ? id === 'demo-budget'
            : lower.includes('private') || lower.includes('leadership')
              ? id.includes('private') || id.includes('hr')
              : lower.includes('general')
                ? id.includes('general')
                : true,
      );
      const auditOperation = randomUUID();
      for (const resource of sources.length ? sources : [undefined])
        await recordAuditEvent({
          org_id: String(req.user!.orgId),
          actor_id: String(req.user!.userId),
          operation_id: auditOperation,
          action: 'chat.context.read',
          outcome: 'success',
          group_ids: [],
          member_ids: [],
          resource_id: resource,
        });
      const answer =
        '**Local fixture responder — no external AI.**\n\n' +
        (sources.length
          ? sources.map((id) => `- ${content[id] ?? id}`).join('\n')
          : 'No permitted fixture record matches this question.');
      const now = new Date().toISOString();
      if (!row) {
        const id = new mongoose.Types.ObjectId().toHexString();
        row = {
          _id: id,
          id,
          userId: String(req.user!.userId),
          orgId: String(req.user!.orgId),
          initiator: String(req.user!.userId),
          title: 'Local access-control test',
          messages: [],
          createdAt: now,
          updatedAt: now,
          isShared: false,
          sharedWith: [],
          status: 'Complete',
          modelInfo,
          access: { isOwner: true, accessLevel: 'owner' },
        };
        conversations.set(id, row);
      }
      const base = {
        contentFormat: 'MARKDOWN',
        citations: [],
        followUpQuestions: [],
        referenceData: [],
        modelInfo,
        createdAt: now,
        updatedAt: now,
        feedback: [],
      };
      const replyId = new mongoose.Types.ObjectId().toHexString();
      row.messages.push(
        {
          ...base,
          _id: new mongoose.Types.ObjectId().toHexString(),
          messageType: 'user_query',
          content: query,
          sourceIds: [],
        },
        {
          ...base,
          _id: replyId,
          messageType: 'bot_response',
          content: answer,
          sourceIds: sources,
        },
      );
      row.updatedAt = now;
      const runId = randomUUID();
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      const frame = (type: string, fields: Record<string, unknown>) =>
        res.write(`data: ${JSON.stringify({ type, ...fields })}\n\n`);
      frame('RUN_STARTED', { threadId: row.id, runId });
      frame('CUSTOM', {
        name: 'conversation_created',
        value: { conversationId: row.id, title: row.title },
      });
      frame('TEXT_MESSAGE_START', {
        messageId: replyId,
        role: 'assistant',
        runId,
      });
      frame('TEXT_MESSAGE_CONTENT', {
        messageId: replyId,
        delta: answer,
        runId,
      });
      frame('TEXT_MESSAGE_END', { messageId: replyId, runId });
      frame('RUN_FINISHED', {
        threadId: row.id,
        runId,
        result: { conversation: await visible(row), meta: {} },
      });
      res.end();
    } catch (error) {
      next(error);
    }
  }
  router.post('/stream', stream);
  router.post('/:id/messages/stream', stream);
  return router;
}
