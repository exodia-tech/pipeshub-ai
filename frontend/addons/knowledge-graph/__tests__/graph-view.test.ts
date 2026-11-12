import { describe, expect, it } from 'vitest';
import { visibleGraph, graphDetail, detailBudget, sameGraph } from '../graph-view';
import type { ClusteredGraph } from '../cluster-layout';

describe('3D graph detail', () => {
  const nodes = Array.from({ length: 502 }, (_, i) => ({ id: String(i), name: `Node ${i}`, kind: 'record', community: i === 501 ? 1 : 0, x: i, y: i, z: i, size: 2, color: '#538bff', degree: 1 }));
  const edges = nodes.slice(1).map(n => ({ source: '0', target: n.id }));
  const data: ClusteredGraph = { nodes, edges, clusters: [], clusterEdges: [] };
  it('shows cluster members without overwhelming the overview with dense links', () => {
    expect(visibleGraph(data).nodes).toHaveLength(0);
    expect(visibleGraph(data, 0).nodes).toHaveLength(501);
    expect(visibleGraph(data, 0).edges).toHaveLength(500);
    expect(data.edges).toHaveLength(501);
  });
  it('reveals every connection of a selected node, including an external neighbor', () => {
    const view = visibleGraph(data, 0, '0');
    expect(view.nodes).toHaveLength(502);
    expect(view.edges).toHaveLength(501);
    expect(view.nodes.some(n => n.community === 1)).toBe(true);
  });
  it('shows all edges in small focused clusters', () => {
    expect(visibleGraph({ ...data, nodes: nodes.slice(0, 3), edges: edges.slice(0, 2) }, 0).edges).toHaveLength(2);
  });
  it('isolates a selected recordÃ¢â‚¬â„¢s neighborhood instead of retaining unrelated cluster members', () => {
    const view = visibleGraph(data, 0, '1');
    expect(view.nodes.map(n => n.id)).toEqual(['0', '1']);
    expect(view.edges).toEqual([{ source: '0', target: '1' }]);
  });
});

it('increases detail as the camera approaches without changing cached data', () => {
  const nodes = Array.from({ length: 2000 }, (_, i) => ({ id: String(i), name: `Node ${i}`, kind: 'record', community: i < 1500 ? 0 : 1, x: i, y: 0, z: 0, size: 2, color: '#538bff', degree: i % 10 }));
  const data: ClusteredGraph = { nodes, edges: [], clusters: [], clusterEdges: [] };
  const original = JSON.stringify(data);
  expect(graphDetail(data).nodes.length).toBeLessThanOrEqual(48);
  expect(graphDetail(data, 0, undefined, 240).nodes.filter(n => n.community === 0)).toHaveLength(240);
  expect(graphDetail(data, 0, undefined, 6000).nodes.filter(n => n.community === 0)).toHaveLength(1500);
  expect(graphDetail(data, 0).nodes.some(n => n.community === 1)).toBe(true);
  expect(detailBudget(100, 1000)).toBe(240);
  expect(detailBudget(100, 300)).toBe(1200);
  expect(detailBudget(100, 150)).toBe(6000);
  expect(JSON.stringify(data)).toBe(original);
});

it('retains every connection whose endpoints are rendered, including dense clusters', () => {
  const nodes = Array.from({ length: 600 }, (_, i) => ({ id: String(i), name: String(i), kind: 'record', community: 0, x: i, y: 0, z: 0, size: 2, color: '#538bff', degree: 1 }));
  const edges = nodes.slice(1).map(n => ({ source: '0', target: n.id }));
  expect(graphDetail({ nodes, edges, clusters: [], clusterEdges: [] }, 0, undefined, 6000).edges).toHaveLength(599);
});

it('recognizes unchanged undirected graphs without ignoring record metadata changes', () => {
  const nodes = [{ id: 'a', name: 'A', kind: 'record' }, { id: 'b', name: 'B', kind: 'record' }];
  const a = { nodes, edges: [{ source: 'a', target: 'b' }] };
  expect(sameGraph(a, { nodes: [...nodes].reverse(), edges: [{ source: 'b', target: 'a' }] })).toBe(true);
  expect(sameGraph(a, { ...a, nodes: [{ ...nodes[0], name: 'Renamed' }, nodes[1]] })).toBe(false);
});
