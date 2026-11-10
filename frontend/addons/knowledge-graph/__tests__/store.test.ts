import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSessionCache } from '@/lib/api/session-cache';
import { useGraphStore } from '../store';

const api = vi.hoisted(() => ({ loadGraph: vi.fn(), workers: vi.fn(), terminate: vi.fn() }));
vi.mock('../api', () => ({ loadGraph: api.loadGraph }));
const graph = { nodes: [], edges: [], clusters: [], clusterEdges: [] };

beforeEach(() => {
  vi.stubGlobal('Worker', class {
    onmessage?: (event: { data: unknown }) => void;
    constructor() { api.workers(); }
    postMessage() { queueMicrotask(() => this.onmessage?.({ data: { result: graph } })); }
    terminate() { api.terminate(); }
  });
  api.loadGraph.mockResolvedValue({ nodes: [], edges: [] });
});
afterEach(() => { clearSessionCache(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

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
    expect(api.workers).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(122000);
    await useGraphStore.getState().load();
    expect(api.workers).toHaveBeenCalledTimes(3);
  });

  it('clears private data on session change and ignores a late response from the old session', async () => {
    let finish: (value: { nodes: []; edges: [] }) => void;
    api.loadGraph.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const old = useGraphStore.getState().load();
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
