import { apiClient } from '@/lib/api';
import { revalidateSwrNamespace, SWR_NS } from '@/lib/api/swr-cache';

const path = (id: string) => `/api/v1/agents/${encodeURIComponent(id)}/avatar`;
function refreshAgent() {
  revalidateSwrNamespace(SWR_NS.agentDetails);
  revalidateSwrNamespace(SWR_NS.agentLists);
}
export const AgentPicturesApi = {
  async read(url: string): Promise<string> {
    return (await apiClient.get<{ dataUrl: string }>(url)).data.dataUrl;
  },
  async upload(id: string, file: File): Promise<void> {
    const form = new FormData(); form.append('file', file);
    await apiClient.put(path(id), form, { headers: { 'Content-Type': 'multipart/form-data' } });
    refreshAgent();
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(path(id));
    refreshAgent();
  },
};
