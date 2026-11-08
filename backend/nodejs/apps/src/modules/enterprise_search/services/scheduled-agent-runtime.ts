import { AuthTokenService } from '../../../libs/services/authtoken.service';
import { AIServiceCommand } from '../../../libs/commands/ai_service/ai.service.command';
import { HttpMethod } from '../../../libs/enums/http-methods.enum';
import { ForbiddenError } from '../../../libs/errors/http.errors';
import { asAccount, forOrg } from '../../../libs/context/orgContext';
import { newSystemRoot, runWithRequestContext } from '../../../libs/context/request-context';
import { getUserRepository } from '../../../libs/repositories/user';
import { AppConfig } from '../../tokens_manager/config/config';
import { buildAiChatRequest } from '../utils/ai-chat-payload';
import { openConversation, completeTurn } from '../utils/non-streaming-chat';
import { buildUserQueryMessage, extractModelInfo } from '../utils/utils';
import { AgentSchedule, ScheduledAgentRun, AgentRunResult } from './agent-schedules';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { getSlackBotStore } from '../../configuration_manager/controller/cm_controller';
import { resolveSoleOrgId } from '../utils/scoped-request';
import { isUserOrgAdmin } from '../../user_management/services/user-admin.service';
import { markdownToSlackMrkdwn } from '../../../integrations/slack-bot/src/utils/md_to_mrkdwn';

export function withoutSlackMentions(text: string): string {
  return text.replace(/<([@#!][^>]*)>/g, '$1');
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
  constructor(private readonly config: () => AppConfig, private readonly store: KeyValueStoreService) {}

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

  async checkOwner(agentId: string, userId: string, headers: Record<string, string>, publicOnly: boolean): Promise<Record<string, unknown>> {
    const result = await new AIServiceCommand<{ agent: Record<string, unknown> }>({
      uri: `${this.config().aiBackend}/api/v1/agent/${encodeURIComponent(agentId)}`,
      method: HttpMethod.GET, headers, maxAttempts: 1, timeoutMs: 30_000,
    }).execute();
    const agent = result.data?.agent;
    if (result.statusCode !== 200 || !agent || agent.createdBy !== userId) {
      throw new ForbiddenError('Only the agent creator can manage its schedule.');
    }
    if (publicOnly) requirePublicResearchAgent(agent);
    return agent;
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
        const auth = new AuthTokenService(config.jwtSecret, config.scopedJwtSecret);
        // A fresh member token for this run; no stored password, PAT or administrator delegation.
        const headers = { Authorization: `Bearer ${auth.generateToken({
          userId: user._id, orgId: schedule.orgId, email: user.email, role: 'member',
        }, '15m')}` };
        const agent = await this.checkOwner(schedule.agentId, schedule.userId, headers, true);
        const slackToken = await this.checkDelivery(schedule);
        const query = `${schedule.prompt}\n\nReporting window: ${new Date(run.periodStart).toISOString()} inclusive to ${new Date(run.periodEnd).toISOString()} exclusive (${schedule.timezone}).\nPreviously covered public links: ${JSON.stringify(schedule.coveredLinks)}. Avoid repeats unless materially changed. This is a draft-only public-research run. Report unavailable evidence honestly. Run reference: ${run.id}.`;
        const body = {
          query, tools: ['web_search.search'], chatMode: 'quick', timezone: schedule.timezone,
          currentTime: new Date(run.startedAt).toISOString(),
          agentCapabilities: { internalSearch: false, webSearch: true, deepSearch: false },
        };
        const conversation = await openConversation({
          orgId: schedule.orgId, userId: schedule.userId, initiator: schedule.userId,
          title: `Scheduled AI brief · ${new Date(run.periodEnd).toISOString().slice(0, 10)}`,
          lastActivityAt: Date.now(), status: 'Inprogress', modelInfo: extractModelInfo(body),
          agentKey: schedule.agentId, sessionType: 'agent', conversationSource: 'agent_chat',
        }, buildUserQueryMessage(query));
        await recordConversation(conversation._id);
        const target = { kind: 'agent' as const, agentKey: schedule.agentId };
        const turn = await completeTurn({
          target, conversation, aiBackend: config.aiBackend, headers,
          request: buildAiChatRequest(target, body, { conversationId: conversation._id, previousConversations: [], isNewConversation: true }),
          modelInfo: extractModelInfo(body), requestId: run.id,
        });
        const messages = turn.conversation.messages;
        const content = Array.isArray(messages) ? messages.filter(message =>
          message && typeof message === 'object' && message.messageType === 'bot_response',
        ).map(message => String(message.content ?? '')).join('\n') : '';
        const links = [...new Set((content.match(/https:\/\/[^\s)\]>]+/g) ?? []).flatMap(value => {
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
        return { conversationId: conversation._id, links, needsReview: true, ...(slackTs ? { slackTs } : {}) };
      });
    }),
  );
}
