import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force-3d';
import type { GraphData, GraphNode } from './api';
import { connectionRadius } from './graph-view';

const COLORS = ['#538bff', '#ae83ee', '#edaa60', '#53c6c3', '#ed7f9e', '#92b867', '#8898ee', '#d19cce'];
export interface PositionedNode extends GraphNode { x: number; y: number; z: number; size: number; color: string; community: number; degree: number }
export interface Cluster { id: number; name: string; count: number; x: number; y: number; z: number; radius: number; color: string; isolated: boolean }
export interface ClusteredGraph { nodes: PositionedNode[]; edges: GraphData['edges']; clusters: Cluster[]; clusterEdges: { source: number; target: number; count: number }[] }

export function clusterLayout(data: GraphData, progress?: (done: number, total: number) => void): ClusteredGraph {
  const graph = new Graph({ type: 'undirected' });
  const nodes = [...data.nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const node of nodes) graph.addNode(node.id, node);
  for (const edge of data.edges) {
    if (edge.source !== edge.target && graph.hasNode(edge.source) && graph.hasNode(edge.target) && !graph.hasEdge(edge.source, edge.target)) graph.addEdge(edge.source, edge.target);
  }
  let seed = 42;
  const rng = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const communities = graph.size ? louvain(graph, { rng }) : {};
  const groups = new Map<number, GraphNode[]>();
  for (const node of nodes) {
    const id = graph.degree(node.id) ? communities[node.id] : -1;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id)!.push(node);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  progress?.(0, nodes.length);
  let placed = 0;
  const positioned: PositionedNode[] = [];
  const clusters: Cluster[] = [];
  const centers: { id: string; radius: number; x?: number; y?: number; z?: number }[] = [];
  ordered.forEach(([, members], index) => {
    for (const node of members) graph.setNodeAttribute(node.id, 'community', index);
    centers.push({ id: String(index), radius: Math.cbrt(members.length) * 36 + 50 });
  });
  const clusterEdges = new Map<string, { source: number; target: number; count: number }>();
  graph.forEachEdge((_, __, source, target) => {
    const a = graph.getNodeAttribute(source, 'community'), b = graph.getNodeAttribute(target, 'community');
    if (a === b) return;
    const key = `${Math.min(a, b)}:${Math.max(a, b)}`;
    const entry = clusterEdges.get(key) || { source: Math.min(a, b), target: Math.max(a, b), count: 0 };
    entry.count++;
    clusterEdges.set(key, entry);
  });
  const links = [...clusterEdges.values()].map(e => ({ source: String(e.source), target: String(e.target), count: e.count, distance: centers[e.source].radius + centers[e.target].radius + 180 }));
  const maxWeight = Math.max(1, ...links.map(e => e.count));
  // Keep the full cluster footprints separate in three dimensions; stronger links attract more.
  forceSimulation(centers, 3).stop().randomSource(rng)
    .force('links', forceLink(links).id(n => (n as typeof centers[number]).id)
      .distance(e => e.distance)
      .strength(e => 0.04 + Math.sqrt(e.count / maxWeight) * 0.2))
    .force('charge', forceManyBody().strength(-3000))
    .force('collide', forceCollide<typeof centers[number]>(n => n.radius * 1.3).iterations(2))
    .force('center', forceCenter()).tick(240);
  ordered.forEach(([group, members], index) => {
    const local = members.map(node => ({ id: node.id, x: undefined as number | undefined, y: undefined as number | undefined, z: undefined as number | undefined }));
    const memberIds = new Set(members.map(n => n.id));
    const localEdges: { source: string; target: string }[] = [];
    for (const node of members) graph.forEachNeighbor(node.id, other => {
      if (node.id < other && memberIds.has(other)) localEdges.push({ source: node.id, target: other });
    });
    forceSimulation(local, 3).stop().randomSource(rng)
      .force('links', forceLink(localEdges).id(n => (n as typeof local[number]).id).distance(18))
      .force('charge', forceManyBody().strength(-20).theta(1.1))
      .force('center', forceCenter()).tick(70);
    let spread = 1;
    for (const node of local) spread = Math.max(spread, Math.hypot(node.x, node.y, node.z));
    const { x, y, z, radius } = centers[index];
    const color = COLORS[index % COLORS.length];
    const prominent = [...members].sort((a, b) => {
      const rank = (n: GraphNode) => (n.kind === 'language' ? -100000 : n.recordId ? 0 : 10000) + graph.degree(n.id);
      return rank(b) - rank(a) || a.name.localeCompare(b.name);
    })[0];
    clusters.push({ id: index, name: prominent.name, count: members.length, x, y, z, radius, color, isolated: group === -1 });
    local.forEach(a => {
      const node = graph.getNodeAttributes(a.id) as GraphNode;
      positioned.push({ ...node, x: x + a.x / spread * radius, y: y + a.y / spread * radius, z: z + a.z / spread * radius,
        community: index, color, degree: graph.degree(a.id), size: connectionRadius(graph.degree(a.id)) });
    });
    placed += members.length;
    progress?.(placed, nodes.length);
  });
  return { nodes: positioned, edges: graph.edges().map(e => ({ source: graph.source(e), target: graph.target(e) })), clusters, clusterEdges: [...clusterEdges.values()] };
}
