import { create } from 'zustand';
import { captureSession, failOnSessionEnd, onSessionEnd } from '@/lib/api/session-cache';
import { useAuthStore } from '@/lib/store/auth-store';
import { decodeJwtPayload } from '@/lib/api/token-refresh';
import { getApiBaseUrl } from '@/lib/utils/api-base-url';
import { readGraphSnapshot, writeGraphSnapshot, clearGraphSnapshots } from '@/lib/storage/graph-snapshot';
import { loadGraph } from './api';
import type { ClusteredGraph } from './cluster-layout';

const CACHE_TTL_MS = 5 * 60 * 1000;
let pending: Promise<void> | undefined;
let activeController: AbortController | undefined;
let activeWorker: Worker | undefined;

interface GraphState {
  data: ClusteredGraph | null;
  phase: 'idle' | 'loading' | 'layout' | 'ready' | 'error';
  progress: { loaded: number; total: number };
  layoutProgress: { done: number; total: number };
  expiresAt: number;
  load(force?: boolean): Promise<void>;
}

export const useGraphStore = create<GraphState>((set, get) => ({
  data: null, phase: 'idle', progress: { loaded: 0, total: 0 }, layoutProgress: { done: 0, total: 0 }, expiresAt: 0,
  load(force = false) {
    if (pending) return pending;
    if (!force && get().data && get().expiresAt > Date.now()) return Promise.resolve();
    const current = captureSession();
    const controller = new AbortController();
    activeController = controller;
    let worker: Worker | undefined;
    set({ data: null, phase: 'loading', progress: { loaded: 0, total: 0 }, layoutProgress: { done: 0, total: 0 } });
    const work = async () => {
      const claims = decodeJwtPayload(useAuthStore.getState().accessToken);
      const scope = typeof claims?.userId === 'string' && typeof claims?.orgId === 'string' ? JSON.stringify([getApiBaseUrl(), claims.userId, claims.orgId]) : '';
      if (force) await clearGraphSnapshots();
      const saved = force ? null : await readGraphSnapshot(scope);
      if (!current()) return;
      if (saved) { set({ data: saved.data, expiresAt: saved.expiresAt, phase: 'ready' }); return; }

      const graph = await loadGraph(controller.signal, (loaded, total) => { if (current()) set({ progress: { loaded, total } }); });
      if (!current()) return;
      set({ phase: 'layout' });
      const data = await new Promise<ClusteredGraph>((resolve, reject) => {
        worker = new Worker(new URL('./layout-worker.ts', import.meta.url));
        activeWorker = worker;
        worker.onmessage = ({ data: message }) => {
          if (!current()) return;
          if (message.progress) set({ layoutProgress: message.progress });
          else if (message.result) resolve(message.result);
          else reject(new Error('Layout failed'));
        };
        worker.onerror = () => reject(new Error('Layout failed'));
        worker.postMessage(graph);
      });
      if (current()) {
        const expiresAt = Date.now() + CACHE_TTL_MS;
        set({ data, phase: 'ready', expiresAt });
        await writeGraphSnapshot(scope, data, expiresAt, current);
      }
    };
    const task = failOnSessionEnd(work()).catch(() => {
      if (current()) set({ data: null, phase: 'error', expiresAt: 0 });
    }).finally(() => {
      worker?.terminate();
      if (pending === task) pending = undefined;
      if (activeController === controller) activeController = undefined;
      if (activeWorker === worker) activeWorker = undefined;
    });
    pending = task;
    return task;
  },
}));

// Private graph data and in-flight work never cross logout, account or workspace changes.
onSessionEnd(() => {
  void clearGraphSnapshots();
  activeController?.abort(); activeWorker?.terminate(); pending = undefined;
  activeController = undefined; activeWorker = undefined;
  useGraphStore.setState(useGraphStore.getInitialState(), true);
});
