'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type Sigma from 'sigma';
import type { ClusteredGraph, PositionedNode } from './cluster-layout';

export interface GraphCamera { cluster(id: number): void; node(id: string): void; reset(): void; zoom(factor: number): void }

export const GraphCanvas = forwardRef<GraphCamera, {
  data: ClusteredGraph; label: string; dark: boolean;
  onSelect(node: PositionedNode): void; onError(): void;
}>(function GraphCanvas({ data, label, dark, onSelect, onError }, ref) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<Sigma | null>(null);
  const callbacks = useRef({ onSelect, onError });
  callbacks.current = { onSelect, onError };

  function focus(ids: string[]) {
    const sigma = renderer.current;
    if (!sigma || !ids.length) return;
    const points = ids.map(id => sigma.getNodeDisplayData(id)).filter(Boolean);
    if (!points.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const point of points) { minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x); minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y); }
    const { width, height } = sigma.getDimensions();
    const ratio = Math.max((maxX - minX) * Math.max(1, height / width), (maxY - minY) * Math.max(1, width / height));
    sigma.getCamera().animate({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, ratio: Math.min(1.5, Math.max(0.08, ratio * 1.3)) }, { duration: 450 });
  }
  useImperativeHandle(ref, () => ({
    cluster: id => focus(data.nodes.filter(n => n.community === id).map(n => n.id)),
    node: id => focus([id]),
    reset: () => { renderer.current?.getCamera().animatedReset({ duration: 450 }); },
    zoom: factor => { const camera = renderer.current?.getCamera(); if (camera) camera.animate({ ratio: camera.getState().ratio * factor }, { duration: 200 }); },
  }));

  useEffect(() => {
    let disposed = false;
    let sigma: Sigma | undefined;
    let resize: ResizeObserver | undefined;
    void Promise.all([import('sigma'), import('graphology'), import('sigma/rendering')]).then(([{ default: SigmaRenderer }, { default: Graph }, { drawDiscNodeLabel }]) => {
      if (disposed || !container.current) return;
      const graph = new Graph({ type: 'undirected' });
      const clusterNames = new Set(data.clusters.filter(c => !c.isolated).map(c => c.name));
      for (const node of data.nodes) graph.addNode(node.id, { ...node, label: node.name });
      for (const edge of data.edges) graph.addEdge(edge.source, edge.target, { size: 0.4, color: dark ? '#444957' : '#c8ced9' });
      sigma = new SigmaRenderer(graph, container.current, {
        labelColor: { color: dark ? '#e7eaf1' : '#202736' }, labelFont: 'Inter, sans-serif', labelSize: 13,
        labelDensity: 0.08, labelRenderedSizeThreshold: 5, stagePadding: 40,
        minCameraRatio: 0.005, maxCameraRatio: 4, hideEdgesOnMove: true, hideLabelsOnMove: true,
        defaultDrawNodeLabel: (context, node, settings) => {
          const overview = !sigma || sigma.getCamera().getState().ratio > 0.45;
          const narrow = container.current.clientWidth < 500;
          if (overview && (narrow || !clusterNames.has(node.label))) return;
          const limit = narrow ? 18 : 28;
          const label = node.label.length > limit ? `${node.label.slice(0, limit - 1)}…` : node.label;
          drawDiscNodeLabel(context, { ...node, label }, settings);
        },
      });
      renderer.current = sigma;
      resize = new ResizeObserver(() => sigma?.resize().refresh());
      resize.observe(container.current);
      const byId = new Map(data.nodes.map(n => [n.id, n]));
      sigma.on('clickNode', ({ node }) => { const value = byId.get(node); if (value) callbacks.current.onSelect(value); });
    }).catch(() => { if (!disposed) callbacks.current.onError(); });
    return () => { disposed = true; resize?.disconnect(); sigma?.kill(); renderer.current = null; };
  }, [data, dark]);

  return <div ref={container} role="img" aria-label={label} style={{ width: '100%', height: '100%', touchAction: 'none' }} />;
});
