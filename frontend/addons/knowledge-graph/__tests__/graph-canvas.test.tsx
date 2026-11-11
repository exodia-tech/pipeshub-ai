import '@/lib/__tests__/test-i18n';
import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { Vector3 } from 'three';
import type { GraphCamera } from '../graph-canvas';
import type { ClusteredGraph } from '../cluster-layout';

const state = vi.hoisted(() => ({ graph: null, label: null, move: vi.fn() }));
vi.mock('3d-force-graph', () => ({ default: class {
  constructor() {
    const graph = { data: { nodes: [], links: [] }, destroy: vi.fn() };
    state.graph = new Proxy(graph, { get(target, key) {
      if (key === 'data') return graph.data;
      if (key === 'destroy') return graph.destroy;
      if (key === '_destructor') return graph.destroy;
      if (key === 'controls') return () => ({ target: new Vector3(), addEventListener: vi.fn(), removeEventListener: vi.fn() });
      if (key === 'scene') return () => ({ updateMatrixWorld: vi.fn() });
      if (key === 'cameraPosition') return state.move;
      if (key === 'camera') return () => ({ position: new Vector3(100, 100, 100) });
      if (key === 'renderer') return () => ({ domElement: document.createElement('canvas'), setPixelRatio: vi.fn() });
      if (key === 'graphData') return value => { if (!value) return graph.data; graph.data = value; return state.graph; };
      if (key === 'nodeLabel') return value => { state.label = value; return state.graph; };
      return () => state.graph;
    }});
    return state.graph;
  }
}}));
import { GraphCanvas } from '../graph-canvas';
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('adapts fixed positions without mutating cached data, escapes hover labels and cleans up the library', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const data: ClusteredGraph = {
    nodes: [{ id: 'r', name: '<img src=x onerror=alert(1)>', kind: 'record', community: 0, x: 1, y: 2, z: 3, size: 2, color: '#538bff', degree: 0 }],
    edges: [], clusters: [{ id: 0, name: 'Team', count: 1, x: 1, y: 2, z: 3, radius: 50, color: '#538bff', isolated: false }], clusterEdges: [],
  };
  const original = JSON.stringify(data), ref = React.createRef<GraphCamera>();
  const view = render(<GraphCanvas ref={ref} data={data} dark label="Graph" onSelect={vi.fn()} onCluster={vi.fn()} onReady={vi.fn()} onError={vi.fn()} />);
  await waitFor(() => expect(state.graph?.data.nodes.some(n => n.id === 'cluster:0')).toBe(true));
  ref.current.cluster(0);
  expect(state.graph.data.nodes[0]).toMatchObject({ id: 'r', fx: 1, fy: 2, fz: 3 });
  expect(state.move.mock.calls.at(-1)[2]).toBeGreaterThan(0);
  const label = state.label(state.graph.data.nodes[0]);
  expect(label.textContent).toBe(data.nodes[0].name);
  expect(label.children.length).toBe(0);
  state.graph.data.nodes[0].x = 999;
  expect(JSON.stringify(data)).toBe(original);
  view.unmount(); expect(state.graph.destroy).toHaveBeenCalledOnce();
});

it('respects reduced-motion preferences for cluster navigation', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const data: ClusteredGraph = {
    nodes: [{ id: 'r', name: 'Record', kind: 'record', community: 0, x: 1, y: 2, z: 3, size: 2, color: '#538bff', degree: 0 }],
    edges: [], clusters: [{ id: 0, name: 'Team', count: 1, x: 1, y: 2, z: 3, radius: 50, color: '#538bff', isolated: false }], clusterEdges: [],
  };
  const ref = React.createRef<GraphCamera>();
  render(<GraphCanvas ref={ref} data={data} dark label="Graph" onSelect={vi.fn()} onCluster={vi.fn()} onReady={vi.fn()} onError={vi.fn()} />);
  await waitFor(() => expect(state.graph?.data.nodes.some(n => n.id === 'cluster:0')).toBe(true));
  ref.current.cluster(0);
  expect(state.move.mock.calls.at(-1)[2]).toBe(0);
});
