import { describe, expect, it } from 'vitest';
import { visibleGraph } from '../graph-view';
import type { ClusteredGraph } from '../cluster-layout';

describe('3D graph detail', () => {
  const nodes = Array.from({ length: 502 }, (_, i) => ({ id: String(i), name: `Node ${i}`, kind: 'record', community: i === 501 ? 1 : 0, x: i, y: i, z: i, size: 2, color: '#538bff', degree: 1 }));
  const edges = nodes.slice(1).map(n => ({ source: '0', target: n.id }));
  const data: ClusteredGraph = { nodes, edges, clusters: [], clusterEdges: [] };
  it('shows cluster members without overwhelming the overview with dense links', () => {
    expect(visibleGraph(data).nodes).toHaveLength(0);
    expect(visibleGraph(data, 0).nodes).toHaveLength(501);
    expect(visibleGraph(data, 0).edges).toHaveLength(0);
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
  it('isolates a selected recordâ€™s neighborhood instead of retaining unrelated cluster members', () => {
    const view = visibleGraph(data, 0, '1');
    expect(view.nodes.map(n => n.id)).toEqual(['0', '1']);
    expect(view.edges).toEqual([{ source: '0', target: '1' }]);
  });
});
