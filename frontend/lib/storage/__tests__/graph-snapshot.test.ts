import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/lib/store/auth-store';
import { readGraphSnapshot, writeGraphSnapshot, clearGraphSnapshots } from '../graph-snapshot';
const data = { nodes: [], edges: [], clusters: [], clusterEdges: [] };
beforeEach(() => {
  const entries = new Map<string, Response>();
  vi.stubGlobal('caches', { open: async () => ({ keys: async () => [...entries.keys()], match: async key => entries.get(key)?.clone(), put: async (key, value) => { entries.set(key, value); }, delete: async key => entries.delete(key) }), delete: async () => entries.clear() });
});
afterEach(async () => { await clearGraphSnapshots(); vi.unstubAllGlobals(); });
it('restores only the same account/workspace snapshot within its lifetime', async () => {
  await writeGraphSnapshot('org-a/user-a', data, Date.now() + 60000, () => true);
  expect((await readGraphSnapshot('org-a/user-a'))?.data).toEqual(data);
  expect(await readGraphSnapshot('org-b/user-a')).toBeNull();
});
it('drops expired, signed-out and late-session snapshots', async () => {
  await writeGraphSnapshot('a', data, Date.now() - 26 * 60 * 1000, () => true);
  expect(await readGraphSnapshot('a')).toBeNull();
  await writeGraphSnapshot('a', data, Date.now() + 60000, () => true);
  await clearGraphSnapshots();
  expect(await readGraphSnapshot('a')).toBeNull();
  await writeGraphSnapshot('a', data, Date.now() + 60000, () => false);
  expect(await readGraphSnapshot('a')).toBeNull();
});
it('falls back when storage is unavailable or full', async () => {
  vi.stubGlobal('caches', { open: async () => { throw new Error('quota'); }, delete: async () => true });
  await expect(writeGraphSnapshot('a', data, Date.now() + 60000, () => true)).resolves.toBeUndefined();
  expect(await readGraphSnapshot('a')).toBeNull();
});

it('clears stored data on logout even if the graph page was not loaded', async () => {
  await writeGraphSnapshot('a', data, Date.now() + 60000, () => true);
  useAuthStore.getState().logout();
  expect(await readGraphSnapshot('a')).toBeNull();
});

it('keeps separate cache entries from evicting one another', async () => {
  await writeGraphSnapshot('a', data, Date.now() + 60000, () => true);
  await writeGraphSnapshot('b', data, Date.now() + 60000, () => true);
  expect((await readGraphSnapshot('a'))?.data).toEqual(data);
  expect((await readGraphSnapshot('b'))?.data).toEqual(data);
});

it('keeps a recently stale snapshot available for background refresh', async () => {
  const expiresAt = Date.now() - 1;
  await writeGraphSnapshot('a', data, expiresAt, () => true);
  expect((await readGraphSnapshot('a'))?.expiresAt).toBe(expiresAt);
});
