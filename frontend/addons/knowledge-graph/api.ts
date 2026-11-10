import { apiClient } from '@/lib/api';

export interface GraphNode { id: string; name: string; kind: string; recordId?: string }
export interface GraphEdge { source: string; target: string }
export interface GraphPage { nodes: GraphNode[]; edges: GraphEdge[]; listed: number; total: number; nextCursor?: string }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[] }

export const GraphApi = {
  async page(cursor?: string, signal?: AbortSignal): Promise<GraphPage> {
    const { data } = await apiClient.post<GraphPage>('/api/v1/search/graph', cursor ? { cursor } : {}, { signal });
    return data;
  },
};

export async function loadGraph(signal: AbortSignal, progress: (loaded: number, total: number) => void): Promise<GraphData> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let loaded = 0;
  do {
    const page = await GraphApi.page(cursor, signal);
    if (signal.aborted) throw new Error('Aborted');
    for (const node of page.nodes) nodes.set(node.id, node);
    for (const edge of page.edges) edges.set(JSON.stringify([edge.source, edge.target]), edge);
    loaded += page.listed;
    progress(loaded, page.total);
    cursor = page.nextCursor || undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Graph pagination did not advance');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { nodes: [...nodes.values()], edges: [...edges.values()].filter(e => nodes.has(e.source) && nodes.has(e.target)) };
}
