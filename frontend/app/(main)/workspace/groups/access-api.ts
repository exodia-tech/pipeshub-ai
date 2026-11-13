import { apiClient } from "@/lib/api";

export interface AccessGroup {
  _key: string;
  name: string;
  description?: string;
  createdAtTimestamp?: number;
  createdByUser?: { userId: string; name?: string; email?: string } | null;
}
export interface AccessGroupMember {
  userId: string;
  userName?: string;
  userEmail?: string;
  profilePicture?: string;
}

export interface ResourcePolicy {
  defaultAllow: boolean;
  revision?: number;
  rules: { ref: string; allow: boolean }[];
}
export interface GroupResource {
  ref: string;
  name: string;
  kind: "connector" | "container" | "record";
  allowed: boolean;
  navigable: boolean;
  explicit: boolean | null;
  connectorType?: string;
  readableMembers: number | null;
  descendantRuleRefs?: string[];
}

export const AccessGroupsApi = {
  async policy(id: string): Promise<ResourcePolicy> {
    const { data } = await apiClient.get<{ policy: ResourcePolicy }>(
      `/api/v1/access-groups/${id}/access`,
    );
    return data.policy;
  },
  async savePolicy(id: string, policy: ResourcePolicy): Promise<void> {
    await apiClient.put(`/api/v1/access-groups/${id}/access`, policy);
  },
  async resources(
    id: string,
    parent?: string,
    skip = 0,
  ): Promise<{
    nodes: GroupResource[];
    hasMore: boolean;
    memberCount: number;
  }> {
    const { data } = await apiClient.get<{
      nodes: GroupResource[];
      hasMore: boolean;
      memberCount: number;
    }>(`/api/v1/access-groups/${id}/resources`, {
      params: { parent, skip, limit: 50 },
    });
    return data;
  },
  async list(skip = 0, limit = 100): Promise<AccessGroup[]> {
    const { data } = await apiClient.get<{ groups: AccessGroup[] }>(
      "/api/v1/access-groups",
      { params: { skip, limit } },
    );
    return data.groups;
  },
  async create(name: string, description?: string): Promise<string> {
    const { data } = await apiClient.post<{ id: string }>(
      "/api/v1/access-groups",
      { name, description },
    );
    return data.id;
  },
  async members(id: string): Promise<AccessGroupMember[]> {
    const members: AccessGroupMember[] = [];
    for (let page = 1; ; page++) {
      const { data } = await apiClient.get<{
        members: AccessGroupMember[];
        memberCount: number;
      }>(`/api/v1/access-groups/${id}/members`, {
        params: { page, limit: 100 },
      });
      members.push(...data.members);
      if (data.members.length < 100 || members.length >= data.memberCount)
        return members;
    }
  },
  async changeMembers(
    id: string,
    operation: "add" | "remove",
    userIds: string[],
  ): Promise<void> {
    await apiClient.post(`/api/v1/access-groups/${id}/members/${operation}`, {
      userIds,
    });
  },
  async rename(id: string, name: string, description?: string): Promise<void> {
    await apiClient.put(`/api/v1/access-groups/${id}`, { name, description });
  },
  async delete(id: string): Promise<void> {
    await apiClient.delete(`/api/v1/access-groups/${id}`);
  },
};
