import { apiClient } from '@/lib/api';

export interface AgentScheduleSettings {
  enabled: boolean;
  days: number[];
  hour: number;
  minute: number;
  timezone: string;
  prompt: string;
  revision?: number;
  slackBotId?: string | null;
  slackChannelId?: string | null;
}
export interface AgentSchedule extends AgentScheduleSettings {
  nextRunAt: number | null;
  runs: { id: string; status: string; startedAt: number; conversationId?: string; slackTs?: string }[];
}
const path = (id: string) => `/api/v1/agents/${encodeURIComponent(id)}/schedule`;
export const AgentSchedulesApi = {
  async read(id: string): Promise<AgentSchedule | null> {
    return (await apiClient.get<{ schedule: AgentSchedule | null }>(path(id))).data.schedule;
  },
  async save(id: string, settings: AgentScheduleSettings): Promise<AgentSchedule> {
    return (await apiClient.put<{ schedule: AgentSchedule }>(path(id), settings)).data.schedule;
  },
  async run(id: string): Promise<AgentSchedule> {
    return (await apiClient.post<{ schedule: AgentSchedule }>(`${path(id)}/run`, {}, { timeout: 660000 })).data.schedule;
  },
};
