import mongoose, { Schema, type QueryFilter } from 'mongoose';
import { isDeepStrictEqual } from 'node:util';
import {
  ConflictError,
  ServiceUnavailableError,
} from '../../errors/http.errors';
import { Logger } from '../../services/logger.service';
import { docStore, DocStoreNotReady } from '../store-select';

export const AUDIT_ACTIONS = [
  'group.members.add',
  'group.members.remove',
  'group.create',
  'group.rename',
  'group.delete',
  'group.access.change',
  'audit.read',
  'audit.export',
  'collection.permission.grant',
  'collection.permission.change',
  'collection.permission.revoke',
  'record.download.start',
  'auth.login',
  'chat.context.read',
  'agent.run',
  'agent.tool',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];
export const AUDIT_OUTCOMES = [
  'intent',
  'success',
  'denied',
  'failed',
  'cancelled',
  'pending',
] as const;

interface AuditRow {
  org_id: string;
  operation_id: string;
  request_id?: string;
  actor_id: string;
  action: AuditAction;
  outcome: (typeof AUDIT_OUTCOMES)[number];
  group_ids: string[];
  member_ids: string[];
  recorded_at: Date;
  resource_id?: string;
  permission_role?: 'OWNER' | 'WRITER' | 'READER';
  agent_event?: {
    run_id: string;
    trace_id: string;
    agent_id: string;
    parent_run_id?: string;
    tool_call_id?: string;
    tool_name?: string;
    model?: string;
  };
  resource_policy?: {
    default_allow: boolean;
    revision: number;
    feature_scopes?: string[] | null;
    rules: { resource_ref: string; allow: boolean }[];
  };
}

const schema = new Schema<AuditRow>(
  {
    org_id: { type: String, required: true },
    operation_id: { type: String, required: true },
    request_id: { type: String, maxlength: 128 },
    actor_id: { type: String, required: true },
    action: {
      type: String,
      required: true,
      enum: AUDIT_ACTIONS,
    },
    outcome: {
      type: String,
      required: true,
      enum: AUDIT_OUTCOMES,
    },
    group_ids: { type: [String], required: true },
    member_ids: { type: [String], required: true },
    resource_id: { type: String, maxlength: 256 },
    permission_role: { type: String, enum: ['OWNER', 'WRITER', 'READER'] },
    agent_event: {
      type: new Schema(
        {
          run_id: String,
          trace_id: String,
          agent_id: String,
          parent_run_id: String,
          tool_call_id: String,
          tool_name: String,
          model: String,
        },
        { _id: false },
      ),
      required: false,
    },
    resource_policy: {
      type: new Schema(
        {
          default_allow: Boolean,
          revision: Number,
          feature_scopes: { type: [String], default: undefined },
          rules: [
            new Schema(
              {
                resource_ref: { type: String, maxlength: 300 },
                allow: Boolean,
              },
              { _id: false },
            ),
          ],
        },
        { _id: false },
      ),
      required: false,
    },
  },
  {
    timestamps: { createdAt: 'recorded_at', updatedAt: false },
    versionKey: false,
  },
);
schema.index({ org_id: 1, recorded_at: -1, _id: -1 });
schema.index({ org_id: 1, actor_id: 1, recorded_at: -1, _id: -1 });
schema.index({ org_id: 1, action: 1, recorded_at: -1, _id: -1 });
schema.index({ org_id: 1, group_ids: 1, recorded_at: -1, _id: -1 });
schema.index({ org_id: 1, resource_id: 1, recorded_at: -1, _id: -1 });
// A service event may be replayed after a lost response; administrative intent/success pairs share IDs.
schema.index(
  { org_id: 1, operation_id: 1 },
  { unique: true, partialFilterExpression: { agent_event: { $exists: true } } },
);
const Events =
  (mongoose.models['exodiaAuditEvent'] as
    mongoose.Model<AuditRow> | undefined) ||
  mongoose.model<AuditRow>('exodiaAuditEvent', schema, 'exodiaAuditEvents');
function requireStore(): void {
  if (docStore() !== 'mongo') throw new DocStoreNotReady('audit');
}
export async function recordAuditEvent(
  event: Pick<
    AuditRow,
    | 'org_id'
    | 'operation_id'
    | 'request_id'
    | 'actor_id'
    | 'action'
    | 'outcome'
    | 'group_ids'
    | 'member_ids'
    | 'resource_id'
    | 'permission_role'
    | 'agent_event'
    | 'resource_policy'
  >,
): Promise<void> {
  const row = {
    ...event,
    org_id: event.org_id.toLowerCase(),
    actor_id: event.actor_id.toLowerCase(),
    group_ids: event.group_ids.map((id) => id.toLowerCase()),
    member_ids: event.member_ids.map((id) => id.toLowerCase()),
  };
  try {
    requireStore();
    if (event.agent_event) await Events.init();
    await Events.create(row);
  } catch (error) {
    if (
      event.agent_event &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 11000
    ) {
      const previous = await Events.findOne({
        org_id: row.org_id,
        operation_id: row.operation_id,
        agent_event: { $exists: true },
      })
        .lean()
        .catch(() => null);
      if (previous) {
        if (
          previous.actor_id === row.actor_id &&
          previous.action === row.action &&
          previous.outcome === row.outcome &&
          isDeepStrictEqual(previous.agent_event, row.agent_event)
        )
          return;
        throw new ConflictError(
          'This audit event ID was already recorded with different metadata.',
        );
      }
    }
    Logger.getInstance().error('Audit event could not be recorded', {
      orgId: event.org_id,
      operationId: event.operation_id,
      action: event.action,
      outcome: event.outcome,
    });
    throw new ServiceUnavailableError(
      event.action === 'agent.run' || event.action === 'agent.tool'
        ? 'The agent audit event could not be recorded.'
        : event.action === 'audit.read' || event.action === 'audit.export'
          ? 'Audit storage is unavailable. Audit history cannot be shown.'
          : event.action === 'record.download.start'
            ? 'Audit storage is unavailable. The document stream was not started.'
            : event.outcome === 'success'
              ? 'The action may have completed, but its audit record could not be saved. Check its current state before retrying.'
              : 'Audit storage is unavailable. The requested change was not applied.',
    );
  }
}
export async function listAuditEvents(
  orgId: string,
  options: {
    action?: AuditAction;
    actorId?: string;
    groupId?: string;
    resourceId?: string;
    outcome?: AuditRow['outcome'];
    from?: Date;
    to?: Date;
    limit: number;
    before?: { time: Date; id: string };
  },
): Promise<{ events: unknown[]; next_cursor: string | null }> {
  const filter: QueryFilter<AuditRow> = { org_id: orgId.toLowerCase() };
  if (options.action) filter.action = options.action;
  if (options.actorId) filter.actor_id = options.actorId.toLowerCase();
  if (options.groupId) filter.group_ids = options.groupId.toLowerCase();
  if (options.resourceId) filter.resource_id = options.resourceId;
  if (options.outcome) filter.outcome = options.outcome;
  if (options.from || options.to)
    filter.recorded_at = {
      ...(options.from ? { $gte: options.from } : {}),
      ...(options.to ? { $lt: options.to } : {}),
    };
  if (options.before) {
    filter.$or = [
      { recorded_at: { $lt: options.before.time } },
      {
        recorded_at: options.before.time,
        _id: { $lt: new mongoose.Types.ObjectId(options.before.id) },
      },
    ];
  }
  let rows;
  try {
    requireStore();
    rows = await Events.find(filter)
      .sort({ recorded_at: -1, _id: -1 })
      .limit(options.limit + 1)
      .lean();
  } catch {
    throw new ServiceUnavailableError('Audit storage is unavailable.');
  }
  const page = rows.slice(0, options.limit);
  const last = page[page.length - 1];
  const next_cursor =
    rows.length > options.limit && last
      ? Buffer.from(
          JSON.stringify({
            time: last.recorded_at.toISOString(),
            id: String(last._id),
          }),
        ).toString('base64url')
      : null;
  return {
    events: page.map((event) => ({
      id: String(event._id),
      operation_id: event.operation_id,
      request_id: event.request_id,
      actor_id: event.actor_id,
      action: event.action,
      outcome: event.outcome,
      group_ids: event.group_ids,
      member_ids: event.member_ids,
      resource_id: event.resource_id,
      permission_role: event.permission_role,
      agent_event: event.agent_event,
      resource_policy: event.resource_policy,
      recorded_at: event.recorded_at,
    })),
    next_cursor,
  };
}
