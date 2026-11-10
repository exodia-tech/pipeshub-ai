'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { NodeObject } from '3d-force-graph';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ClusteredGraph, PositionedNode } from './cluster-layout';
import { visibleGraph } from './graph-view';

export interface GraphCamera {
  cluster(id: number): void; node(id: string): void; reset(): void; zoom(factor: number): void; rotate(angle: number): void;
}
interface ViewNode extends NodeObject { name: string; color: string; radius: number; cluster?: number; record?: PositionedNode; count?: number }

export const GraphCanvas = forwardRef<GraphCamera, {
  data: ClusteredGraph; label: string; dark: boolean;
  onSelect(node: PositionedNode): void; onCluster(id: number): void; onReady(): void; onError(): void;
}>(function GraphCanvas({ data, label, dark, onSelect, onCluster, onReady, onError }, ref) {
  const { t, i18n } = useTranslation();
  const container = useRef<HTMLDivElement>(null);
  const camera = useRef<GraphCamera>(null);
  const callbacks = useRef({ onSelect, onCluster, onReady, onError });
  callbacks.current = { onSelect, onCluster, onReady, onError };
  useImperativeHandle(ref, () => ({
    cluster: id => camera.current?.cluster(id), node: id => camera.current?.node(id),
    reset: () => camera.current?.reset(), zoom: factor => camera.current?.zoom(factor), rotate: angle => camera.current?.rotate(angle),
  }));

  useEffect(() => {
    let disposed = false, cleanup = () => {};
    void Promise.all([import('3d-force-graph'), import('three-spritetext'), import('three')]).then(([{ default: ForceGraph }, { default: SpriteText }, THREE]) => {
      if (disposed || !container.current) return;
      const host = container.current;
      const graph = new ForceGraph(host, { controlType: 'orbit' });
      const controls = graph.controls() as OrbitControls;
      controls.enableDamping = false;
      controls.minDistance = 20; controls.maxDistance = 50000;
      let expanded: number | undefined, selected: string | undefined;
      const compact = new Intl.NumberFormat(i18n.resolvedLanguage || 'en-US', { notation: 'compact', maximumFractionDigits: 1 });
      const byId = new Map(data.nodes.map(n => [n.id, n]));
      const labels: InstanceType<typeof THREE.Sprite>[] = [];
      function disposeLabels() { for (const sprite of labels.splice(0)) { sprite.material.map?.dispose(); sprite.material.dispose(); } }
      cleanup = () => { disposeLabels(); graph._destructor(); host.replaceChildren(); camera.current = null; };
      graph.backgroundColor('#00000000').showNavInfo(false).enableNodeDrag(false)
        .nodeRelSize(1).nodeVal(node => Math.pow((node as ViewNode).radius, 3)).nodeColor('color').nodeOpacity(1).nodeResolution(12)
        .cooldownTicks(0).onEngineStop(() => { fit(); callbacks.current.onReady(); }).linkColor(() => dark ? '#9db5db' : '#687e9f').linkOpacity(0.08)
        .nodeLabel(node => {
          // Names come from indexed documents; never let the library interpret them as HTML.
          const label = document.createElement('span'); label.textContent = (node as ViewNode).name; return label;
        })
        .nodeThreeObjectExtend(false).nodeThreeObject(node => {
          const n = node as ViewNode;
          if (n.cluster === undefined) return undefined;
          const group = new THREE.Group();
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
          const context = canvas.getContext('2d'); if (!context) throw new Error('Halo canvas unavailable');
          const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 126);
          gradient.addColorStop(0, n.color + '08'); gradient.addColorStop(0.78, n.color + '12');
          gradient.addColorStop(0.91, n.color + '80'); gradient.addColorStop(1, n.color + '00');
          context.fillStyle = gradient; context.fillRect(0, 0, 256, 256);
          const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthWrite: false }));
          halo.scale.set(n.radius * 2, n.radius * 2, 1); group.add(halo); labels.push(halo);
          const sprite = new SpriteText(`${n.name.length > 26 ? n.name.slice(0, 25) + 'â€¦' : n.name}\n${compact.format(n.count)}`, n.radius * 0.22, dark ? '#edf3ff' : '#243451');
          sprite.fontFace = 'Inter, sans-serif'; sprite.fontWeight = '600'; sprite.material.depthTest = false;
          labels.push(sprite); group.add(sprite); return group;
        })
        .onNodeClick(node => {
          const n = node as ViewNode;
          if (n.cluster !== undefined) callbacks.current.onCluster(n.cluster);
          else if (n.record) { selected = n.record.id; rebuild(); fit(); callbacks.current.onSelect(n.record); }
        });
      function rebuild() {
        disposeLabels();
        const view = visibleGraph(data, expanded, selected);
        const nodes: ViewNode[] = view.nodes.map(n => ({ id: n.id, name: n.name, record: n, color: n.id === selected ? dark ? '#ffffff' : '#1859d6' : n.color, radius: n.id === selected ? Math.max(9, n.size * 2) : Math.max(2, n.size), x: n.x, y: n.y, z: n.z, fx: n.x, fy: n.y, fz: n.z }));
        if (!selected && expanded === undefined) for (const c of data.clusters) {
          nodes.push({ id: `cluster:${c.id}`, name: c.isolated ? t('graph.unconnected') : c.name, cluster: c.id, count: c.count, color: c.color, radius: Math.min(380, Math.max(40, Math.sqrt(c.count) * 6)), x: c.x, y: c.y, z: c.z, fx: c.x, fy: c.y, fz: c.z });
        }
        const ids = new Set(nodes.map(n => n.id));
        const links = view.edges.map(e => ({ ...e }));
        if (!selected) for (const e of data.clusterEdges) {
          const source = `cluster:${e.source}`, target = `cluster:${e.target}`;
          if (ids.has(source) && ids.has(target)) links.push({ source, target });
        }
        // The library mutates node/link objects; pass fresh copies to protect the session cache.
        graph.graphData({ nodes, links });
      }
      function fit() {
        const nodes = graph.graphData().nodes as ViewNode[];
        const box = new THREE.Box3();
        for (const n of nodes) { const point = new THREE.Vector3(n.x, n.y, n.z), extent = new THREE.Vector3(n.radius, n.radius, n.radius); box.expandByPoint(point.clone().sub(extent)); box.expandByPoint(point.add(extent)); }
        if (box.isEmpty()) return;
        const sphere = box.getBoundingSphere(new THREE.Sphere()), aspect = host.clientWidth / host.clientHeight;
        const angle = Math.min(Math.PI / 7.2, Math.atan(Math.tan(Math.PI / 7.2) * aspect));
        const direction = graph.camera().position.clone().sub(controls.target).normalize();
        if (!direction.lengthSq()) direction.set(0.4, 0.25, 1).normalize();
        // Sprite bounds are camera-facing; fit their data extents instead of library mesh bounds.
        graph.cameraPosition(sphere.center.clone().addScaledVector(direction, Math.max(30, sphere.radius) / Math.sin(angle) * 1.05), sphere.center);
      }
      camera.current = {
        cluster(id) { expanded = id; selected = undefined; rebuild(); fit(); },
        node(id) { const n = byId.get(id); if (!n) return; expanded = n.community; selected = id; rebuild(); fit(); },
        reset() { expanded = undefined; selected = undefined; rebuild(); fit(); },
        zoom(factor) { const offset = graph.camera().position.clone().sub(controls.target); offset.setLength(Math.max(20, Math.min(50000, offset.length() * factor))); graph.cameraPosition(controls.target.clone().add(offset), controls.target); },
        rotate(angle) { const offset = graph.camera().position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle); graph.cameraPosition(controls.target.clone().add(offset), controls.target); },
      };
      const lost = (event: Event) => { event.preventDefault(); callbacks.current.onError(); };
      const canvas = graph.renderer().domElement;
      canvas.addEventListener('webglcontextlost', lost);
      graph.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      const resize = new ResizeObserver(() => {
        if (!host.clientWidth || !host.clientHeight) return;
        graph.width(host.clientWidth).height(host.clientHeight); fit();
      });
      const destroy = cleanup;
      cleanup = () => { resize.disconnect(); canvas.removeEventListener('webglcontextlost', lost); destroy(); };
      rebuild(); resize.observe(host);
    }).catch(() => { cleanup(); if (!disposed) callbacks.current.onError(); });
    return () => { disposed = true; cleanup(); };
  }, [data, dark, t, i18n]);

  return <div ref={container} role="img" aria-label={label} style={{ width: '100%', height: '100%', touchAction: 'none', overflow: 'hidden' }} />;
});
