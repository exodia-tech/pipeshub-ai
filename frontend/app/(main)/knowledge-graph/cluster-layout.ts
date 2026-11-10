import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import type { GraphData, GraphNode } from './api';

const COLORS = ['#538bff', '#ae83ee', '#edaa60', '#53c6c3', '#ed7f9e', '#92b867', '#8898ee', '#d19cce'];
export interface PositionedNode extends GraphNode { x: number; y: number; size: number; color: string; community: number }
export interface Cluster { id: number; name: string; count: number; x: number; y: number; radius: number; color: string; isolated: boolean }
export interface ClusteredGraph { nodes: PositionedNode[]; edges: GraphData['edges']; clusters: Cluster[] }

export function clusterLayout(data: GraphData): ClusteredGraph {
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
  const positioned: PositionedNode[] = [];
  const clusters: Cluster[] = [];
  // Communities occupy separate discs; ForceAtlas2 resolves the actual links inside each disc.
  const largestRadius = Math.sqrt(ordered[0]?.[1].length || 1) * 12 + 30;
  const columns = Math.ceil(Math.sqrt(ordered.length));
  ordered.forEach(([group, members], index) => {
    const local = new Graph({ type: 'undirected' });
    members.forEach((node, i) => {
      const angle = i * Math.PI * (3 - Math.sqrt(5));
      local.addNode(node.id, { x: Math.cos(angle) * Math.sqrt(i + 1), y: Math.sin(angle) * Math.sqrt(i + 1), size: 1 });
    });
    for (const node of members) graph.forEachNeighbor(node.id, other => {
      if (local.hasNode(other) && !local.hasEdge(node.id, other)) local.addEdge(node.id, other);
    });
    if (local.size) forceAtlas2.assign(local, { iterations: 100, settings: { ...forceAtlas2.inferSettings(local), barnesHutOptimize: true, gravity: 1, scalingRatio: 8 } });
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    local.forEachNode((_, a) => { minX = Math.min(minX, a.x); maxX = Math.max(maxX, a.x); minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y); });
    const spread = Math.max(maxX - minX, maxY - minY, 1);
    const radius = Math.sqrt(members.length) * 12 + 30;
    const x = (index % columns) * largestRadius * 2.6;
    const y = Math.floor(index / columns) * largestRadius * 2.6;
    const color = COLORS[index % COLORS.length];
    const prominent = [...members].sort((a, b) => {
      const rank = (n: GraphNode) => (n.kind === 'language' ? -100000 : n.recordId ? 0 : 10000) + graph.degree(n.id);
      return rank(b) - rank(a) || a.name.localeCompare(b.name);
    })[0];
    clusters.push({ id: index, name: prominent.name, count: members.length, x, y, radius, color, isolated: group === -1 });
    local.forEachNode((id, a) => {
      const node = graph.getNodeAttributes(id) as GraphNode;
      positioned.push({ ...node, x: x + (a.x - (minX + maxX) / 2) / spread * radius * 2, y: y + (a.y - (minY + maxY) / 2) / spread * radius * 2,
        community: index, color, size: Math.min(9, 2 + Math.log2(1 + graph.degree(id)) * 0.9) });
    });
  });
  return { nodes: positioned, edges: graph.edges().map(e => ({ source: graph.source(e), target: graph.target(e) })), clusters };
}
