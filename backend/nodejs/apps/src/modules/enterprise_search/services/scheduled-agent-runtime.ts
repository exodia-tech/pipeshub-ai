import { AuthTokenService } from '../../../libs/services/authtoken.service';
import { AIServiceCommand } from '../../../libs/commands/ai_service/ai.service.command';
import { HttpMethod } from '../../../libs/enums/http-methods.enum';
import { ForbiddenError } from '../../../libs/errors/http.errors';
import { asAccount, forOrg } from '../../../libs/context/orgContext';
import { newSystemRoot, runWithRequestContext } from '../../../libs/context/request-context';
import { getUserRepository } from '../../../libs/repositories/user';
import { AppConfig } from '../../tokens_manager/config/config';
import { groupScopeResolver } from '../../../libs/services/group-scope-policy';
import { OAuthScopeNames } from '../../../libs/enums/oauth-scopes.enum';
import { AiChatRequest, buildAiChatRequest } from '../utils/ai-chat-payload';
import { openConversation, completeTurn } from '../utils/non-streaming-chat';
import { buildUserQueryMessage, extractModelInfo } from '../utils/utils';
import { AgentSchedule, ScheduledAgentRun, AgentRunResult } from './agent-schedules';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { getSlackBotStore } from '../../configuration_manager/controller/cm_controller';
import { resolveSoleOrgId } from '../utils/scoped-request';
import { isUserOrgAdmin } from '../../user_management/services/user-admin.service';
import { markdownToSlackMrkdwn } from '../../../integrations/slack-bot/src/utils/md_to_mrkdwn';
import { AgentProjectGrants } from './agent-project-grants';
import { Logger } from '../../../libs/services/logger.service';

const logger = Logger.getInstance({ service: 'ScheduledAgentRuntime' });

export function constrainProjectScheduleRequest(request: AiChatRequest, model: { modelKey: string; modelName: string }, modelFingerprint: string): AiChatRequest {
  // Project scope treats [] as all project tools; this run must grant none.
  request.payload.tools = [];
  request.payload.safeRetrievalOnly = true;
  request.payload.modelKey = model.modelKey;
  request.payload.modelName = model.modelName;
  request.payload.safeModelFingerprint = modelFingerprint;
  return request;
}

export function withoutSlackMentions(text: string): string {
  return text.replace(/<(?=[@#!<])/g, '&lt;');
}

export function requirePublicResearchAgent(agent: Record<string, unknown>): void {
  // shortcut: unattended actions need per-tool governance before extending this public-research pilot.
  for (const field of ['knowledge', 'toolsets', 'mcpServers', 'apiToolsetTools', 'skills']) {
    if (!Array.isArray(agent[field]) || agent[field].length !== 0) {
      throw new ForbiddenError('Scheduled pilots require an agent with no company knowledge or action tools.');
    }
  }
  if (agent.mcpServersUnavailable || agent.isServiceAccount || agent.sendUserContext !== false || !agent.isActive) {
    throw new ForbiddenError('This agent is not eligible for scheduled public research.');
  }
}

export class ScheduledAgentRuntime {
  constructor(private readonly config: () => AppConfig, private readonly store: KeyValueStoreService, private readonly grants: AgentProjectGrants) {}

  async isReady(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config().aiBackend}/health`, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      return response.ok;
    } catch { return false; }
  }

  async checkDelivery(schedule: Pick<AgentSchedule, 'orgId' | 'userId' | 'agentId' | 'slackBotId' | 'slackChannelId'>): Promise<string | null> {
    if (!schedule.slackBotId && !schedule.slackChannelId) return null;
    if (!schedule.slackBotId || !schedule.slackChannelId || !await isUserOrgAdmin(schedule.userId, schedule.orgId) || await resolveSoleOrgId() !== schedule.orgId) {
      throw new ForbiddenError('Slack delivery requires an active organization administrator and an approved bot/channel pair.');
    }
    const bot = (await getSlackBotStore(this.store)).configs.find(entry => entry.id === schedule.slackBotId && entry.agentId === schedule.agentId);
    if (!bot) throw new ForbiddenError('Connect a Slack bot to this agent before enabling delivery.');
    return bot.botToken;
  }

  async getAgent(agentId: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
    const result = await new AIServiceCommand<{ agent: Record<string, unknown> }>({
      uri: `${this.config().aiBackend}/api/v1/agent/${encodeURIComponent(agentId)}`,
      method: HttpMethod.GET, headers, maxAttempts: 1, timeoutMs: 30_000,
    }).execute();
    if (result.statusCode !== 200 || !result.data?.agent) throw new ForbiddenError('This agent is not available.');
    return result.data.agent;
  }

  async checkOwner(agentId: string, userId: string, headers: Record<string, string>, publicOnly: boolean): Promise<Record<string, unknown>> {
    const agent = await this.getAgent(agentId, headers);
    if (agent.createdBy !== userId) throw new ForbiddenError('Only the agent creator can manage its settings.');
    if (publicOnly) requirePublicResearchAgent(agent);
    return agent;
  }

  async updateAvatar(agentId: string, avatarUrl: string | null, headers: Record<string, string>): Promise<void> {
    const result = await new AIServiceCommand({
      uri: `${this.config().aiBackend}/api/v1/agent/${encodeURIComponent(agentId)}`,
      method: HttpMethod.PUT, headers, body: { avatarUrl }, maxAttempts: 1, timeoutMs: 30_000,
    }).execute();
    if (result.statusCode !== 200) throw new Error('The agent picture could not be saved.');
  }

  async deliveryOptions(orgId: string, userId: string, agentId: string): Promise<{ canManage: boolean; bots: { id: string; name: string }[] }> {
    if (!await isUserOrgAdmin(userId, orgId) || await resolveSoleOrgId() !== orgId) return { canManage: false, bots: [] };
    const store = await getSlackBotStore(this.store);
    return { canManage: true, bots: store.configs.filter(bot => bot.agentId === agentId).map(bot => ({ id: bot.id, name: bot.name })) };
  }

  execute = async (
    schedule: AgentSchedule, run: ScheduledAgentRun, recordConversation: (id: string) => Promise<void>,
  ): Promise<AgentRunResult> => runWithRequestContext({ rootId: newSystemRoot() }, () =>
    forOrg(schedule.orgId, 'agent-schedule', async () => {
      const user = await getUserRepository().getLive(schedule.orgId, schedule.userId);
      if (!user || user.isDisabled || user.isDeleted || user.kind === 'service') {
        throw new ForbiddenError('The schedule owner is no longer active.');
      }
      return asAccount(schedule.orgId, schedule.userId, 'agent-schedule', async () => {
        const config = this.config();
        // Scheduled runs use member credentials, never an administrator exemption.
        const scopeLimit = groupScopeResolver(config, false);
        const checkScopes = async () => {
          const scopes = await scopeLimit(schedule.orgId, schedule.userId);
          const required = [OAuthScopeNames.AGENT_READ, OAuthScopeNames.AGENT_EXECUTE,
            ...(schedule.projectId ? [OAuthScopeNames.PROJECT_READ] : [])];
          if (scopes !== null && !required.every((scope) => scopes.includes(scope))) {
            throw new ForbiddenError('Your access group no longer allows this scheduled action.');
          }
        };
        await checkScopes();
        const auth = new AuthTokenService(config.jwtSecret, config.scopedJwtSecret);
        // A fresh member token for this run; no stored password, PAT or administrator delegation.
        const headers = { Authorization: `Bearer ${auth.generateToken({
          userId: user._id, orgId: schedule.orgId, email: user.email, role: 'member',
        }, '15m')}` };
        const isProject = Boolean(schedule.projectId);
        let agent = await this.checkOwner(schedule.agentId, schedule.userId, headers, !isProject);
        if (isProject && (!schedule.projectGrantId || schedule.slackBotId || schedule.slackChannelId)) throw new ForbiddenError('Project schedules need an approved scope and cannot post to Slack.');
        let approved = isProject ? await this.grants.validate(schedule.orgId, schedule.userId, schedule.agentId, agent, schedule.projectId!, schedule.projectGrantId!) : undefined;
        let project = approved?.project;
        const slackToken = isProject ? null : await this.checkDelivery(schedule);
        const query = `${schedule.prompt}\n\nReporting window: ${new Date(run.periodStart).toISOString()} inclusive to ${new Date(run.periodEnd).toISOString()} exclusive (${schedule.timezone}).\n${isProject ? 'Use only the approved project sources. This is a private draft for human review. Report unavailable evidence honestly.' : `Previously covered public links: ${JSON.stringify(schedule.coveredLinks)}. Avoid repeats unless materially changed. This is a draft-only public-research run. Report unavailable evidence honestly.`} Run reference: ${run.id}.`;
        const body = {
          query, tools: isProject ? [] : ['web_search.search'], chatMode: 'quick', timezone: schedule.timezone,
          currentTime: new Date(run.startedAt).toISOString(),
          agentCapabilities: { internalSearch: isProject, webSearch: !isProject, deepSearch: false },
          ...(isProject ? { runId: run.id, modelKey: approved!.model.modelKey, modelName: approved!.model.modelName, modelProvider: approved!.model.provider } : {}),
        };
        const conversation = await openConversation({
          orgId: schedule.orgId, userId: schedule.userId, initiator: schedule.userId,
          title: `Scheduled AI brief · ${new Date(run.periodEnd).toISOString().slice(0, 10)}`,
          lastActivityAt: Date.now(), status: 'Inprogress', modelInfo: extractModelInfo(body),
          agentKey: schedule.agentId, sessionType: 'agent', conversationSource: 'agent_chat',
          ...(project ? { projectId: project._id, projectVisibility: 'private' as const } : {}),
        }, buildUserQueryMessage(query));
        await recordConversation(conversation._id);
        if (isProject) {
          agent = await this.checkOwner(schedule.agentId, schedule.userId, headers, false);
          approved = await this.grants.validate(schedule.orgId, schedule.userId, schedule.agentId, agent, schedule.projectId!, schedule.projectGrantId!);
          project = approved.project;
        }
        const target = { kind: 'agent' as const, agentKey: schedule.agentId };
        await checkScopes();
        const request = buildAiChatRequest(target, body, { conversationId: conversation._id, previousConversations: [], isNewConversation: true, project });
        if (isProject) constrainProjectScheduleRequest(request, approved!.model, approved!.modelFingerprint);
        const turn = await completeTurn({
          target, conversation, aiBackend: config.aiBackend, headers,
          request,
          modelInfo: extractModelInfo(body), requestId: run.id,
        });
        const messages = turn.conversation.messages;
        const content = Array.isArray(messages) ? messages.filter(message =>
          message && typeof message === 'object' && message.messageType === 'bot_response',
        ).map(message => String(message.content ?? '')).join('\n') : '';
        const links = isProject ? [] : [...new Set((content.match(/https:\/\/[^\s)\]>]+/g) ?? []).flatMap(value => {
          try {
            const url = new URL(value);
            if (url.username || url.password) return [];
            url.hash = '';
            return [url.href];
          } catch { return []; }
        }))];
        let slackTs: string | undefined;
        if (slackToken && schedule.slackChannelId) {
          const currentSlackToken = await this.checkDelivery(schedule);
          if (!currentSlackToken) throw new Error('Slack delivery is no longer authorized');
          const draft = content.trim();
          if (!draft) throw new Error('No draft was saved for delivery');
          const response = await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
            headers: { Authorization: `Bearer ${currentSlackToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ channel: schedule.slackChannelId, client_msg_id: run.id,
              text: withoutSlackMentions(`${String(agent.name)} · AI briefing draft\n${markdownToSlackMrkdwn(draft).slice(0, 12000)}\n\n${config.frontendUrl.replace(/\/$/, '')}/chat/?agentId=${encodeURIComponent(schedule.agentId)}`),
              unfurl_links: false, unfurl_media: false }),
          });
          const posted = await response.json() as { ok?: boolean; ts?: string };
          if (!response.ok || !posted.ok || !posted.ts) throw new Error('Slack delivery was not confirmed');
          slackTs = posted.ts;
        }
        if (isProject) logger.info('Project agent schedule completed', { audit: 'agent_schedule_run', outcome: 'needs_review', orgId: schedule.orgId, userId: schedule.userId, agentId: schedule.agentId, projectId: schedule.projectId, grantId: schedule.projectGrantId, runId: run.id });
        return { conversationId: conversation._id, links, needsReview: true, ...(slackTs ? { slackTs } : {}) };
      });
    }).catch(error => {
      if (schedule.projectId) logger.warn('Project agent schedule denied or failed', { audit: 'agent_schedule_run', outcome: 'not_completed', orgId: schedule.orgId, userId: schedule.userId, agentId: schedule.agentId, projectId: schedule.projectId, grantId: schedule.projectGrantId, runId: run.id });
      throw error;
    }),
  );
}
