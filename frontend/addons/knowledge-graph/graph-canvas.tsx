'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeObject } from '3d-force-graph';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ClusteredGraph, PositionedNode } from './cluster-layout';
import { detailBudget, graphDetail, visibleGraph } from './graph-view';

export interface GraphCamera {
  cluster(id: number): void; node(id: string): void; reset(): void; zoom(factor: number): void; rotate(angle: number): void;
}
interface ViewNode extends NodeObject { name: string; color: string; radius: number; cluster?: number; record?: PositionedNode; count?: number }

export const GraphCanvas = forwardRef<GraphCamera, {
  data: ClusteredGraph; label: string; dark: boolean;
  onSelect(node: PositionedNode): void; onCluster(id: number): void; onReady(): void; onError(): void;
  onDetailChange?(id: number | null, visible: number): void;
}>(function GraphCanvas({ data, label, dark, onSelect, onCluster, onReady, onError, onDetailChange }, ref) {
  const { t } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const camera = useRef<GraphCamera>(null);
  const callbacks = useRef({ onSelect, onCluster, onReady, onError, onDetailChange });
  callbacks.current = { onSelect, onCluster, onReady, onError, onDetailChange };
  useImperativeHandle(ref, () => ({
    cluster: id => camera.current?.cluster(id), node: id => camera.current?.node(id),
    reset: () => camera.current?.reset(), zoom: factor => camera.current?.zoom(factor), rotate: angle => camera.current?.rotate(angle),
  }));

  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void Promise.all([import('3d-force-graph'), import('three')]).then(([{ default: ForceGraph }, THREE]) => {
      if (disposed || !container.current) return;
      const host = container.current, graph = new ForceGraph(host, { controlType: 'orbit' });
      const controls = graph.controls() as OrbitControls;
      controls.enableDamping = false; controls.minDistance = 20; controls.maxDistance = 50000;
      let expanded: number | undefined, selected: string | undefined, budget = 240, initial = true, moving = false, frame = 0;
      let transition: ReturnType<typeof setTimeout>;
      const duration = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 650;
      const byId = new Map(data.nodes.map(n => [n.id, n]));
      cleanup = () => { graph._destructor(); host.replaceChildren(); camera.current = null; };
      graph.backgroundColor('#00000000').showNavInfo(false).enableNodeDrag(false)
        .nodeRelSize(1).nodeVal(node => Math.pow((node as ViewNode).radius, 3)).nodeColor('color').nodeOpacity(1).nodeResolution(10)
        .cooldownTicks(0).onEngineStop(() => { if (initial) { initial = false; fit(undefined, 0); } callbacks.current.onReady(); })
        .linkColor(() => dark ? '#9db5db' : '#687e9f').linkOpacity(0.08)
        .nodeLabel(node => {
          const n = node as ViewNode, label = document.createElement('span');
          // Indexed names are text, never HTML interpreted by the viewer.
          label.textContent = n.cluster === undefined ? n.name : `${n.name} · ${n.count.toLocaleString()}`; return label;
        })
        .onNodeClick(node => {
          const n = node as ViewNode;
          if (n.cluster !== undefined) callbacks.current.onCluster(n.cluster);
          else if (n.record) { camera.current?.node(n.record.id); callbacks.current.onSelect(n.record); }
        });
      function rebuild() {
        const view = graphDetail(data, expanded, selected, budget);
        const nodes: ViewNode[] = view.nodes.map(n => ({ id: n.id, name: n.name, record: n, color: n.id === selected ? dark ? '#ffffff' : '#1859d6' : expanded === undefined || n.community === expanded ? n.color : '#' + new THREE.Color(n.color).multiplyScalar(dark ? 0.35 : 0.65).getHexString(), radius: n.id === selected ? Math.max(9, n.size * 2) : Math.max(expanded === undefined ? 6 : 2, n.size), x: n.x, y: n.y, z: n.z, fx: n.x, fy: n.y, fz: n.z }));
        for (const c of data.clusters) {
          if (c.id === expanded) continue;
          nodes.push({ id: `cluster:${c.id}`, name: c.isolated ? t('graph.unconnected') : c.name, cluster: c.id, count: c.count, color: expanded === undefined ? c.color : '#' + new THREE.Color(c.color).multiplyScalar(dark ? 0.35 : 0.65).getHexString(), radius: Math.min(24, Math.max(8, Math.cbrt(c.count) * 1.5)), x: c.x, y: c.y, z: c.z, fx: c.x, fy: c.y, fz: c.z });
        }
        const ids = new Set(nodes.map(n => n.id)), links = view.edges.map(e => ({ ...e }));
        if (expanded === undefined) for (const e of data.clusterEdges) {
          const source = `cluster:${e.source}`, target = `cluster:${e.target}`;
          if (ids.has(source) && ids.has(target)) links.push({ source, target });
        }
        // The library mutates its input; protect the shared cached layout with fresh objects.
        graph.graphData({ nodes, links });
        callbacks.current.onDetailChange?.(expanded ?? null, view.nodes.length);
      }
      function move(position: InstanceType<typeof THREE.Vector3>, target: InstanceType<typeof THREE.Vector3>, ms: number) {
        clearTimeout(transition); moving = true;
        graph.cameraPosition(position, target, ms);
        transition = setTimeout(() => { moving = false; updateDetail(); }, ms + 30);
      }
      function fit(id?: number, ms = duration) {
        const box = new THREE.Box3();
        if (selected) {
          for (const n of visibleGraph(data, expanded, selected).nodes) box.expandByPoint(new THREE.Vector3(n.x, n.y, n.z));
        } else for (const c of data.clusters) {
          if (id !== undefined && c.id !== id) continue;
          const center = new THREE.Vector3(c.x, c.y, c.z), radius = new THREE.Vector3(c.radius, c.radius, c.radius);
          box.expandByPoint(center.clone().sub(radius)); box.expandByPoint(center.add(radius));
        }
        if (box.isEmpty()) return;
        const cluster = selected ? undefined : data.clusters.find(c => c.id === id);
        const sphere = cluster ? new THREE.Sphere(new THREE.Vector3(cluster.x, cluster.y, cluster.z), cluster.radius) : box.getBoundingSphere(new THREE.Sphere());
        const aspect = Math.max(1, host.clientWidth) / Math.max(1, host.clientHeight);
        const angle = Math.min(Math.PI / 7.2, Math.atan(Math.tan(Math.PI / 7.2) * aspect));
        const direction = graph.camera().position.clone().sub(controls.target).normalize();
        if (!direction.lengthSq()) direction.set(0.4, 0.25, 1).normalize();
        move(sphere.center.clone().addScaledVector(direction, Math.max(45, sphere.radius) / Math.sin(angle) * 1.05), sphere.center, ms);
      }
      function updateDetail() {
        if (disposed || moving || selected) return;
        const position = graph.camera().position;
        const current = data.clusters.find(c => c.id === expanded);
        let next = current;
        if (current && position.distanceTo(current) > current.radius * 7) next = undefined;
        if (!next) next = data.clusters.filter(c => position.distanceTo(c) < c.radius * 3 && controls.target.distanceTo(c) < c.radius * 2)
          .sort((a, b) => position.distanceTo(a) / a.radius - position.distanceTo(b) / b.radius)[0];
        const nextBudget = next ? detailBudget(next.radius, position.distanceTo(next)) : 240;
        if (next?.id !== expanded || nextBudget !== budget) {
          expanded = next?.id; budget = nextBudget; rebuild();
        }
      }
      const changed = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; updateDetail(); }); };
      controls.addEventListener('change', changed);
      camera.current = {
        cluster(id) { expanded = id; selected = undefined; budget = 240; rebuild(); fit(id); },
        node(id) { const n = byId.get(id); if (!n) return; expanded = n.community; selected = id; rebuild(); fit(n.community); },
        reset() { expanded = undefined; selected = undefined; budget = 240; rebuild(); fit(); },
        zoom(factor) { const offset = graph.camera().position.clone().sub(controls.target); offset.setLength(Math.max(20, Math.min(50000, offset.length() * factor))); move(controls.target.clone().add(offset), controls.target.clone(), duration ? 250 : 0); },
        rotate(angle) { const offset = graph.camera().position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle); move(controls.target.clone().add(offset), controls.target.clone(), duration ? 250 : 0); },
      };
      const lost = (event: Event) => { event.preventDefault(); callbacks.current.onError(); };
      const canvas = graph.renderer().domElement;
      canvas.addEventListener('webglcontextlost', lost); graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const resize = new ResizeObserver(() => { if (host.clientWidth && host.clientHeight) { graph.width(host.clientWidth).height(host.clientHeight); fit(expanded, 0); } });
      const destroy = cleanup;
      cleanup = () => { clearTimeout(transition); cancelAnimationFrame(frame); controls.removeEventListener('change', changed); resize.disconnect(); canvas.removeEventListener('webglcontextlost', lost); destroy(); };
      rebuild(); resize.observe(host);
    }).catch(() => { cleanup(); if (!disposed) callbacks.current.onError(); });
    return () => { disposed = true; cleanup(); };
  }, [data, dark, t]);

  return <div ref={container} role="img" aria-label={label} style={{ width: '100%', height: '100%', touchAction: 'none', overflow: 'hidden' }} />;
});
