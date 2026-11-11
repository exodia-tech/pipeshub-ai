import type { ClusteredGraph } from '@/addons/knowledge-graph/cluster-layout';

const CACHE_NAME = 'exodia-graph-layout-v1';
const NONCE_KEY = 'exodia-graph-session';
let queue: Promise<unknown> = Promise.resolve();

function identity(scope: string) {
  if (!scope || typeof window === 'undefined' || typeof caches === 'undefined') return null;
  let nonce = sessionStorage.getItem(NONCE_KEY);
  if (!nonce) { nonce = crypto.randomUUID(); sessionStorage.setItem(NONCE_KEY, nonce); }
  return JSON.stringify([scope, nonce]);
}
function snapshotUrl(owner: string) { return new URL('/__exodia_graph_snapshot__/' + encodeURIComponent(owner), window.location.origin).href; }

export async function readGraphSnapshot(scope: string): Promise<{ data: ClusteredGraph; expiresAt: number } | null> {
  try {
    await queue;
    const owner = identity(scope); if (!owner) return null;
    const cache = await caches.open(CACHE_NAME), response = await cache.match(snapshotUrl(owner));
    if (!response) return null;
    const entry = await response.json();
    if (entry.identity !== owner || !(entry.expiresAt > Date.now()) || !Array.isArray(entry.data?.nodes) || !Array.isArray(entry.data?.edges) || !Array.isArray(entry.data?.clusters) || !Array.isArray(entry.data?.clusterEdges)
      || !entry.data.nodes.every(n => typeof n.id === 'string' && typeof n.name === 'string' && typeof n.kind === 'string' && typeof n.color === 'string' && [n.x, n.y, n.z, n.size, n.community, n.degree].every(Number.isFinite))
      || !entry.data.clusters.every(c => typeof c.name === 'string' && typeof c.color === 'string' && [c.id, c.x, c.y, c.z, c.radius, c.count].every(Number.isFinite))
      || !entry.data.edges.every(e => typeof e.source === 'string' && typeof e.target === 'string')
      || !entry.data.clusterEdges.every(e => [e.source, e.target, e.count].every(Number.isFinite))) {
      await cache.delete(snapshotUrl(owner)); return null;
    }
    return { data: entry.data, expiresAt: entry.expiresAt };
  } catch { return null; }
}

export function writeGraphSnapshot(scope: string, data: ClusteredGraph, expiresAt: number, current: () => boolean) {
  queue = queue.then(async () => {
    if (!current()) return;
    const owner = identity(scope); if (!owner) return;
    const cache = await caches.open(CACHE_NAME);
    for (const key of await cache.keys()) {
      const saved = await cache.match(key);
      if (Number(saved?.headers.get('X-Graph-Expires-At')) <= Date.now()) await cache.delete(key);
    }
    if (current()) await cache.put(snapshotUrl(owner), new Response(JSON.stringify({ identity: owner, expiresAt, data }), { headers: { 'Content-Type': 'application/json', 'X-Graph-Expires-At': String(expiresAt) } }));
  }).catch(() => {});
  return queue;
}

export function clearGraphSnapshots() {
  try { sessionStorage.removeItem(NONCE_KEY); } catch { /* Storage can be disabled. */ }
  queue = queue.then(async () => { if (typeof caches !== 'undefined') await caches.delete(CACHE_NAME); }).catch(() => {});
  return queue;
}
