import type { ClusteredGraph } from './cluster-layout';

export function connectionRadius(degree: number) {
  return Math.min(14, Math.max(1.5, Math.cbrt(degree + 1) * 1.8));
}

export function visibleGraph(data: ClusteredGraph, community?: number, selected?: string) {
  const neighbors = new Set<string>();
  if (selected) for (const e of data.edges) { if (e.source === selected) neighbors.add(e.target); if (e.target === selected) neighbors.add(e.source); }
  const nodes = data.nodes.filter(n => selected ? n.id === selected || neighbors.has(n.id) : n.community === community);
  const ids = new Set(nodes.map(n => n.id));
  // Dense clusters reveal detailed connections on selection instead of a hairball.
  const edges = !selected && nodes.length > 500 ? [] : data.edges.filter(e => ids.has(e.source) && ids.has(e.target) && (!selected || e.source === selected || e.target === selected));
  return { nodes, edges };
}
