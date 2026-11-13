import { apiClient } from "@/lib/api";

export interface AuditEvent {
  id: string;
  operation_id: string;
  request_id?: string;
  actor_id: string;
  action: string;
  outcome: string;
  group_ids: string[];
  member_ids: string[];
  recorded_at: string;
  resource_id?: string;
  permission_role?: string;
  agent_event?: {
    run_id: string;
    trace_id: string;
    agent_id: string;
    parent_run_id?: string;
    tool_name?: string;
    tool_call_id?: string;
    model?: string;
  };
  resource_policy?: {
    default_allow: boolean;
    revision: number;
    feature_scopes?: string[] | null;
    rules: { resource_ref: string; allow: boolean }[];
  };
}

export interface AuditPageData {
  events: AuditEvent[];
  next_cursor: string | null;
}

export const auditApi = {
  async list(params: Record<string, string>): Promise<AuditPageData> {
    const { data } = await apiClient.get<AuditPageData>("/api/v1/audit", {
      params,
    });
    return data;
  },
};
