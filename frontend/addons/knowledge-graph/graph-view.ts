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

export function detailBudget(radius: number, distance: number) {
  const proximity = radius / Math.max(1, distance);
  return proximity > 0.5 ? 6000 : proximity > 0.28 ? 1200 : 240;
}

export function graphDetail(data: ClusteredGraph, community?: number, selected?: string, budget = 240) {
  const focused = visibleGraph(data, community, selected);
  const detail = selected ? focused.nodes : [...focused.nodes].sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id)).slice(0, budget);
  const nodes = new Map(detail.map(n => [n.id, n]));
  const groups = new Map<number, typeof data.nodes>();
  for (const n of data.nodes) { if (n.community === community && !selected) continue; if (!groups.has(n.community)) groups.set(n.community, []); groups.get(n.community).push(n); }
  for (const group of groups.values()) {
    const step = Math.max(1, Math.ceil(group.length / 24));
    for (let i = 0; i < group.length; i += step) nodes.set(group[i].id, group[i]);
  }
  const ids = new Set(detail.map(n => n.id));
  return { nodes: [...nodes.values()], edges: focused.edges.filter(e => ids.has(e.source) && ids.has(e.target)) };
}
