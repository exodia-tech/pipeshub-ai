'use client';

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { ClusteredGraph, PositionedNode } from './cluster-layout';
import { visibleGraph } from './graph-view';

export interface GraphCamera {
  cluster(id: number): void; node(id: string): void; reset(): void; zoom(factor: number): void; rotate(angle: number): void;
}

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
    void Promise.all([import('three'), import('three/addons/controls/OrbitControls.js')]).then(([THREE, { OrbitControls }]) => {
      if (disposed || !container.current) return;
      const host = container.current;
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      host.appendChild(renderer.domElement);
      cleanup = () => { renderer.dispose(); renderer.domElement.remove(); camera.current = null; };
      const scene = new THREE.Scene();
      const perspective = new THREE.PerspectiveCamera(45, 1, 1, 100000);
      const controls = new OrbitControls(perspective, renderer.domElement);
      controls.enableDamping = false;
      controls.minDistance = 20; controls.maxDistance = 50000;
      const ambient = new THREE.HemisphereLight(0xffffff, 0x334466, 2.5);
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(1, 2, 3); scene.add(ambient, light);
      let group = new THREE.Group(); scene.add(group);
      let expanded: number | undefined, selected: string | undefined;
      let instances: ReturnType<typeof makeInstances> | undefined;
      let bubbles: { mesh: InstanceType<typeof THREE.Mesh>; id: number }[] = [];
      let labels: { sprite: InstanceType<typeof THREE.Sprite>; center: InstanceType<typeof THREE.Vector3>; radius: number; screen?: boolean }[] = [];
      const byId = new Map(data.nodes.map(n => [n.id, n]));
      const bounds = new THREE.Box3();
      for (const c of data.clusters) { const r = Math.max(55, Math.cbrt(c.count) * 24); bounds.expandByPoint(new THREE.Vector3(c.x - r, c.y - r, c.z - r)); bounds.expandByPoint(new THREE.Vector3(c.x + r, c.y + r, c.z + r)); }
      const center = bounds.getCenter(new THREE.Vector3());
      const compact = new Intl.NumberFormat(i18n.resolvedLanguage || 'en-US', { notation: 'compact', maximumFractionDigits: 1 });
      const draw = () => {
        if (disposed) return;
        for (const label of labels) {
          label.sprite.position.copy(label.center).addScaledVector(perspective.position.clone().sub(label.center).normalize(), label.radius * 1.02);
          if (label.screen) {
            const size = perspective.position.distanceTo(label.center) * 2 * Math.tan(THREE.MathUtils.degToRad(perspective.fov / 2)) * 40 / host.clientHeight;
            label.sprite.scale.set(size * 4, size, 1);
            label.sprite.position.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(perspective.quaternion), size * 0.8);
          }
        }
        renderer.render(scene, perspective);
      };
      controls.addEventListener('change', draw);
      function disposeGroup() {
        group.traverse(object => {
          if (object instanceof THREE.InstancedMesh) object.dispose();
          if ('geometry' in object) (object.geometry as InstanceType<typeof THREE.BufferGeometry>).dispose();
          if ('material' in object) {
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            for (const material of materials) { if (material.map) material.map.dispose(); material.dispose(); }
          }
        });
        scene.remove(group);
      }
      function makeInstances(nodes: PositionedNode[]) {
        const mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial(), nodes.length);
        const matrix = new THREE.Matrix4(), color = new THREE.Color();
        nodes.forEach((n, i) => {
          const size = n.id === selected ? Math.max(9, n.size * 2) : Math.max(2, n.size);
          matrix.makeScale(size, size, size); matrix.setPosition(n.x, n.y, n.z); mesh.setMatrixAt(i, matrix);
          mesh.setColorAt(i, color.set(n.id === selected ? '#ffffff' : n.color));
        });
        group.add(mesh); return { mesh, nodes };
      }
      function rebuild() {
        disposeGroup(); group = new THREE.Group(); scene.add(group); bubbles = []; labels = []; instances = undefined;
        const { nodes: visible, edges } = visibleGraph(data, expanded, selected);
        const opened = new Set(visible.map(n => n.community));
        const lines: number[] = [], highlighted: number[] = [];
        if (!selected) for (const e of data.clusterEdges) { const a = data.clusters[e.source], b = data.clusters[e.target]; lines.push(a.x, a.y, a.z, b.x, b.y, b.z); }
        for (const e of edges) {
          const a = byId.get(e.source), b = byId.get(e.target);
          const target = selected && (e.source === selected || e.target === selected) ? highlighted : lines;
          target.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
        for (const [vertices, opacity] of [[lines, 0.08], [highlighted, 0.45]] as const) {
          const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
          group.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: dark ? '#9db5db' : '#687e9f', transparent: true, opacity, depthWrite: false })));
        }
        if (visible.length) instances = makeInstances(visible);
        if (selected) for (const n of [byId.get(selected)]) {
          const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
          const context = canvas.getContext('2d'); if (!context) throw new Error('Label canvas unavailable');
          context.fillStyle = dark ? '#20232e' : '#ffffff'; context.fillRect(0, 0, 512, 128);
          context.fillStyle = dark ? '#e7eaf1' : '#202736'; context.font = '500 48px Inter, sans-serif'; context.textAlign = 'center';
          let name = n.name; while (context.measureText(name).width > 480 && name.length > 1) name = name.slice(0, -2) + '…';
          context.fillText(name, 256, 55); context.font = '36px Inter, sans-serif'; context.fillText(n.degree.toLocaleString(), 256, 105);
          const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
          group.add(sprite); labels.push({ sprite, center: new THREE.Vector3(n.x, n.y, n.z), radius: Math.max(9, n.size * 2), screen: true });
        }
        for (const c of data.clusters) {
          if (selected || c.id === expanded || opened.has(c.id)) continue;
          // Volume encodes members; text stays camera-facing while the sphere shows depth.
          const radius = Math.max(55, Math.cbrt(c.count) * 24);
          const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 16), new THREE.MeshStandardMaterial({ color: c.color, roughness: 0.65 }));
          mesh.position.set(c.x, c.y, c.z); group.add(mesh); bubbles.push({ mesh, id: c.id });
          const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
          const context = canvas.getContext('2d'); if (!context) throw new Error('Label canvas unavailable');
          context.fillStyle = '#101820'; context.textAlign = 'center'; context.textBaseline = 'middle';
          context.font = '500 28px Inter, sans-serif';
          const name = c.isolated ? t('graph.unconnected') : c.name;
          const words = name.split(/\s+/); const lines: string[] = []; let line = '';
          for (const word of words) { const next = line ? `${line} ${word}` : word; if (context.measureText(next).width > 410 && line) { lines.push(line); line = word; } else line = next; }
          if (line) lines.push(line);
          lines.slice(0, 2).forEach((value, i) => { let text = value; while (context.measureText(text).width > 410 && text.length > 1) text = text.slice(0, -2) + '…'; context.fillText(text, 256, 78 + i * 34); });
          context.font = '600 42px Inter, sans-serif'; context.fillText(compact.format(c.count), 256, 172);
          const texture = new THREE.CanvasTexture(canvas);
          texture.colorSpace = THREE.SRGBColorSpace;
          const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthWrite: false }));
          sprite.scale.set(radius * 2, radius, 1); group.add(sprite);
          labels.push({ sprite, center: mesh.position.clone(), radius });
        }
        draw();
      }
      function focus(point: { x: number; y: number; z: number }, radius: number) {
        const target = new THREE.Vector3(point.x, point.y, point.z);
        const direction = perspective.position.clone().sub(controls.target).normalize();
        if (!direction.lengthSq()) direction.set(0.4, 0.25, 1).normalize();
        const vertical = THREE.MathUtils.degToRad(perspective.fov / 2);
        const limitingAngle = Math.min(vertical, Math.atan(Math.tan(vertical) * perspective.aspect));
        const distance = Math.max(30, radius / Math.sin(limitingAngle) * 1.12);
        controls.target.copy(target); perspective.position.copy(target).addScaledVector(direction, distance); controls.update(); draw();
      }
      function fitOverview() {
        const direction = perspective.position.clone().sub(controls.target).normalize();
        const right = new THREE.Vector3().crossVectors(perspective.up, direction).normalize();
        const up = new THREE.Vector3().crossVectors(direction, right).normalize();
        const v = THREE.MathUtils.degToRad(perspective.fov / 2), h = Math.atan(Math.tan(v) * perspective.aspect);
        let distance = 30;
        for (const c of data.clusters) {
          const p = new THREE.Vector3(c.x, c.y, c.z).sub(center), radius = Math.max(55, Math.cbrt(c.count) * 24);
          distance = Math.max(distance, p.dot(direction) + Math.abs(p.dot(right)) / Math.tan(h) + radius / Math.sin(h), p.dot(direction) + Math.abs(p.dot(up)) / Math.tan(v) + radius / Math.sin(v));
        }
        controls.target.copy(center); perspective.position.copy(center).addScaledVector(direction, distance * 1.12); controls.update(); draw();
      }
      function focusSelection() {
        const selection = visibleGraph(data, expanded, selected).nodes;
        const box = new THREE.Box3();
        for (const n of selection) box.expandByPoint(new THREE.Vector3(n.x, n.y, n.z));
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        focus(sphere.center, Math.max(50, sphere.radius + 30));
      }
      camera.current = {
        cluster(id) { expanded = id; selected = undefined; rebuild(); const c = data.clusters.find(c => c.id === id); if (c) focus(c, c.radius); },
        node(id) { const n = byId.get(id); if (!n) return; expanded = n.community; selected = id; rebuild(); focusSelection(); },
        reset() { expanded = undefined; selected = undefined; rebuild(); controls.target.copy(center); perspective.position.copy(center).add(new THREE.Vector3(0.4, 0.25, 1).normalize()); fitOverview(); },
        zoom(factor) { const offset = perspective.position.clone().sub(controls.target); offset.setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, offset.length() * factor))); perspective.position.copy(controls.target).add(offset); controls.update(); draw(); },
        rotate(angle) { const offset = perspective.position.clone().sub(controls.target).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle); perspective.position.copy(controls.target).add(offset); controls.update(); draw(); },
      };
      const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(); let down = { x: 0, y: 0 }, multiTouch = false;
      const pointers = new Set<number>();
      const pointerDown = (event: PointerEvent) => { pointers.add(event.pointerId); if (pointers.size > 1) multiTouch = true; down = { x: event.clientX, y: event.clientY }; };
      const pointerUp = (event: PointerEvent) => {
        pointers.delete(event.pointerId);
        if (multiTouch) { if (!pointers.size) multiTouch = false; return; }
        if (event.button !== 0) return;
        if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return;
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1); ray.setFromCamera(pointer, perspective);
        const targets = bubbles.map(b => b.mesh); if (instances) targets.push(instances.mesh);
        const hit = ray.intersectObjects(targets, false)[0]; if (!hit) return;
        if (instances && hit.object === instances.mesh && hit.instanceId !== undefined) {
          const node = instances.nodes[hit.instanceId]; selected = node.id; rebuild(); focusSelection(); callbacks.current.onSelect(node);
        } else { const bubble = bubbles.find(b => b.mesh === hit.object); if (bubble) callbacks.current.onCluster(bubble.id); }
      };
      const pointerCancel = (event: PointerEvent) => { pointers.delete(event.pointerId); if (!pointers.size) multiTouch = false; };
      const contextLost = (event: Event) => { event.preventDefault(); callbacks.current.onError(); };
      renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointerup', pointerUp); renderer.domElement.addEventListener('pointercancel', pointerCancel); renderer.domElement.addEventListener('webglcontextlost', contextLost);
      let initial = true;
      const resize = new ResizeObserver(() => {
        if (!host.clientWidth || !host.clientHeight) return;
        renderer.setSize(host.clientWidth, host.clientHeight); perspective.aspect = host.clientWidth / host.clientHeight; perspective.updateProjectionMatrix();
        try {
          if (initial) { initial = false; camera.current.reset(); callbacks.current.onReady(); }
          else if (selected) focusSelection();
          else if (expanded !== undefined) { const c = data.clusters.find(c => c.id === expanded); if (c) focus(c, c.radius); }
          else fitOverview();
        } catch { callbacks.current.onError(); }
      });
      cleanup = () => {
        resize.disconnect(); controls.removeEventListener('change', draw); controls.dispose();
        renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp); renderer.domElement.removeEventListener('pointercancel', pointerCancel); renderer.domElement.removeEventListener('webglcontextlost', contextLost);
        disposeGroup(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); camera.current = null;
      };
      resize.observe(host);
    }).catch(() => { cleanup(); if (!disposed) callbacks.current.onError(); });
    return () => { disposed = true; cleanup(); };
  }, [data, dark, t, i18n]);

  return <div ref={container} role="img" aria-label={label} style={{ width: '100%', height: '100%', touchAction: 'none' }} />;
});
