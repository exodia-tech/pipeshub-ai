import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiClient: { post } }));
import { GraphApi, loadGraph } from '../api';

afterEach(() => vi.resetAllMocks());

describe('Graph API', () => {
  it('uses the signed-in client without client-supplied identity', async () => {
    post.mockResolvedValue({ data: { nodes: [], edges: [], listed: 0, total: 0 } });
    await GraphApi.page();
    expect(post).toHaveBeenCalledWith('/api/v1/search/graph', {}, { signal: undefined });
  });
  it('loads every page, deduplicates nodes and keeps cross-page edges', async () => {
    post.mockResolvedValueOnce({ data: { nodes: [{ id: 'a' }], edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'private' }], listed: 1, total: 2, nextCursor: 'page-2' } });
    post.mockResolvedValueOnce({ data: { nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ source: 'a', target: 'b' }], listed: 1, total: 2 } });
    const progress = vi.fn();
    const signal = new AbortController().signal;
    const graph = await loadGraph(signal, progress);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ source: 'a', target: 'b' }]);
    expect(post).toHaveBeenLastCalledWith('/api/v1/search/graph', { cursor: 'page-2' }, { signal });
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });
  it('rejects a repeated cursor and a failed page instead of reporting completion', async () => {
    post.mockResolvedValue({ data: { nodes: [], edges: [], listed: 0, total: 10, nextCursor: 'same' } });
    await expect(loadGraph(new AbortController().signal, vi.fn())).rejects.toThrow('did not advance');
    post.mockRejectedValueOnce(new Error('unavailable'));
    await expect(loadGraph(new AbortController().signal, vi.fn())).rejects.toThrow('unavailable');
  });
});
