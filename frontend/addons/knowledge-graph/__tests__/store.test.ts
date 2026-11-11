import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSessionCache } from '@/lib/api/session-cache';
import { useAuthStore } from '@/lib/store/auth-store';
import { clearGraphSnapshots } from '@/lib/storage/graph-snapshot';
import { useGraphStore } from '../store';

const api = vi.hoisted(() => ({ loadGraph: vi.fn(), workers: vi.fn(), terminate: vi.fn() }));
vi.mock('../api', () => ({ loadGraph: api.loadGraph }));
const graph = { nodes: [], edges: [], clusters: [], clusterEdges: [] };

beforeEach(() => {
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { open: async () => ({ keys: async () => [...entries.keys()], match: async key => entries.get(key)?.clone(), put: async (key, value) => { entries.set(key, value); }, delete: async key => entries.delete(key) }), delete: async () => entries.clear() });
  useAuthStore.setState({ accessToken: 'header.' + btoa(JSON.stringify({ userId: 'user-a', orgId: 'org-a' })) + '.test' });

  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: unknown }) => void;
    constructor() { api.workers(); }
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { result: graph } })); }
    terminate() { api.terminate(); }
  });
  api.loadGraph.mockResolvedValue({ nodes: [], edges: [] });
});
afterEach(async () => { clearSessionCache(); await clearGraphSnapshots(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('Session-scoped graph cache', () => {
  it('deduplicates in-flight requests and reuses completed layout, but refresh and expiry reload', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const a = useGraphStore.getState().load();
    expect(useGraphStore.getState().load()).toBe(a);
    await a;
    await useGraphStore.getState().load();
    expect(api.loadGraph).toHaveBeenCalledTimes(1);
    expect(api.workers).toHaveBeenCalledTimes(1);
    await useGraphStore.getState().load(true);
    expect(api.workers).toHaveBeenCalledTimes(1);
    expect(api.loadGraph).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(302000);
    await useGraphStore.getState().load();
    expect(api.workers).toHaveBeenCalledTimes(1);
    expect(api.loadGraph).toHaveBeenCalledTimes(3);
  });

  it('restores a completed snapshot after page memory is recreated', async () => {
    await useGraphStore.getState().load();
    useGraphStore.setState(useGraphStore.getInitialState(), true);
    await useGraphStore.getState().load();
    expect(api.loadGraph).toHaveBeenCalledTimes(1);
    expect(api.workers).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('keeps the saved graph visible during %s refresh', async force => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await useGraphStore.getState().load();
    clock.mockReturnValue(302000);
    if (!force) useGraphStore.setState(useGraphStore.getInitialState(), true);
    let finish: (value: { nodes: []; edges: [] }) => void;
    api.loadGraph.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const refresh = useGraphStore.getState().load(force);
    await vi.waitFor(() => expect(api.loadGraph).toHaveBeenCalledTimes(2));
    expect(useGraphStore.getState().data).toEqual(graph);
    finish({ nodes: [], edges: [] });
    await refresh;
  });

  it('clears private data on session change and ignores a late response from the old session', async () => {
    let finish: (value: { nodes: []; edges: [] }) => void;
    api.loadGraph.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = useGraphStore.getState().load();
    await vi.waitFor(() => expect(api.loadGraph).toHaveBeenCalled());
    const signal = api.loadGraph.mock.calls[0][0] as AbortSignal;
    clearSessionCache();
    expect(signal.aborted).toBe(true);
    expect(useGraphStore.getState().data).toBeNull();
    await useGraphStore.getState().load();
    finish({ nodes: [], edges: [] });
    await old;
    expect(useGraphStore.getState().phase).toBe('ready');
    expect(api.workers).toHaveBeenCalledTimes(1);
    clearSessionCache();
    expect(useGraphStore.getState().data).toBeNull();
    expect(useGraphStore.getState().phase).toBe('idle');
  });
});
