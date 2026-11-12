import { describe, expect, it } from 'vitest';
import { clusterLayout } from '../cluster-layout';
import type { GraphData } from '../api';
import { connectionRadius } from '../graph-view';

describe('Graph communities', () => {
  it('sizes nodes by connection count with a readable minimum and a bounded maximum', () => {
    expect(connectionRadius(25)).toBeGreaterThan(connectionRadius(4));
    expect(connectionRadius(0)).toBeGreaterThan(0);
    expect(connectionRadius(1e9)).toBe(14);
  });
  it('finds connected communities, preserves every node/edge and is deterministic', () => {
    const nodes = Array.from({ length: 21 }, (_, i) => ({ id: String(i), name: `Node ${i}`, kind: i % 5 === 0 ? 'topic' : 'record' }));
    const edges = [];
    for (let start = 0; start < 20; start += 5) for (let i = start; i < start + 5; i++) for (let j = i + 1; j < start + 5; j++) edges.push({ source: String(i), target: String(j) });
    edges.push({ source: '4', target: '5' }, { source: '9', target: '10' });
    const result = clusterLayout({ nodes, edges });
    expect(result.nodes).toHaveLength(21);
    expect(result.edges).toHaveLength(edges.length);
    expect(result.clusters).toHaveLength(5);
    expect(result.clusterEdges.reduce((sum, edge) => sum + edge.count, 0)).toBe(2);
    expect(result.nodes.find(n => n.id === '0').community).toEqual(result.nodes.find(n => n.id === '4').community);
    expect(result.nodes.find(n => n.id === '0').community).not.toEqual(result.nodes.find(n => n.id === '5').community);
    expect(result.clusters.filter(c => c.isolated)).toHaveLength(1);
    expect(result.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z))).toBe(true);
    expect(new Set(result.nodes.map(n => n.z)).size).toBeGreaterThan(5);
    expect(clusterLayout({ nodes, edges })).toEqual(result);
  });
  it('handles empty and entirely disconnected graphs', () => {
    expect(clusterLayout({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [], clusters: [], clusterEdges: [] });
    const graph: GraphData = { nodes: [{ id: 'solo', name: 'Solo', kind: 'record' }], edges: [] };
    expect(clusterLayout(graph).clusters[0].isolated).toBe(true);
  });
  it('lays out a 5,000-record graph without dropping nodes or connections', () => {
    const nodes: GraphData['nodes'] = [];
    const edges: GraphData['edges'] = [];
    for (let group = 0; group < 50; group++) {
      const topic = `topic-${group}`;
      nodes.push({ id: topic, name: topic, kind: 'topic' });
      for (let record = 0; record < 100; record++) {
        const id = `record-${group}-${record}`;
        nodes.push({ id, name: id, kind: 'record' });
        edges.push({ source: id, target: topic });
      }
    }
    const result = clusterLayout({ nodes, edges });
    expect(result.nodes).toHaveLength(5050);
    expect(result.edges).toHaveLength(5000);
    expect(result.clusters).toHaveLength(50);
    expect(result.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y) && Number.isFinite(n.z))).toBe(true);
  }, 30000);
});
