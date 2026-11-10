# Reuse a 3D graph viewer

Researched 2026-11-10 against upstream documentation and source. Recommendation: replace the hand-written Three.js viewer with **`react-force-graph-3d`**, keeping the existing permission-filtered loader, Louvain communities, worker-produced XYZ positions, cache and cluster-selection UI.

## Fit

| Option | Evidence and tradeoff | Decision |
| --- | --- | --- |
| `react-force-graph-3d` | React binding for the Three.js/WebGL graph viewer; typed package, React peer dependency and MIT license. The 3D-only package avoids the umbrella package's VR/AR dependencies. | Best fit for the current React add-on. |
| `3d-force-graph` | Same renderer with imperative mounting, built-in orbit controls, sizing and value-based sphere volume. | Equally viable if its direct API makes the existing mount effect shorter; do not install both direct and wrapper packages without need. |
| `@cosmos.gl/graph` | MIT GPU layout/rendering; official API supplies XY coordinates, despite using WebGL. Its current docs advertise touch support and large-scale rendering. | Strong 2D alternative, not the requested orbitable XYZ view. |
| `ngraph.pixel` | MIT 3D shader renderer; its guide defaults to WASD flight and explicitly calls navigation inconvenient. | More integration work for this dashboard than the recommended library. |

Sources: [3D React package manifest](https://github.com/vasturiano/react-force-graph/blob/master/src/packages/react-force-graph-3d/package.json), [React MIT license](https://github.com/vasturiano/react-force-graph/blob/master/LICENSE), [imperative viewer API](https://github.com/vasturiano/3d-force-graph), [Cosmos docs and XY example](https://github.com/cosmosgl/graph), [ngraph.pixel documentation](https://github.com/anvaka/ngraph.pixel).

## What the library replaces

The React API exposes node/link hover and click callbacks, `cameraPosition`, filtered `zoomToFit`, navigation controls, dimensions, value-based node size, and custom Three objects. `cooldownTicks` stops its force simulation; `enableNodeDrag={false}` avoids reheating the layout on drag. Use fixed `fx`, `fy`, `fz` copied from the existing worker coordinates, so rendering does not silently change the arrangement. Keep 44px platform buttons calling the library camera API. [React API](https://github.com/vasturiano/react-force-graph)

The upstream expandable-node example updates graph data after a click. It demonstrates visibility management for a **tree**, not automatic community detection or a ready-made clustered knowledge graph. Keep our community computation and feed only summary nodes plus the selected cluster/neighborhood to the viewer. [Expandable example source](https://github.com/vasturiano/3d-force-graph/blob/master/example/expandable-nodes/index.html)

Labels and counts on summary nodes can follow the official `three-spritetext` example through `nodeThreeObject`; ordinary records should use default spheres and hover labels. Do not create text sprites for every record. [Text-node example](https://github.com/vasturiano/3d-force-graph/blob/master/example/text-nodes/index.html)

The renderer's source accesses `window` on import. Load it only in a client-side dynamic import with SSR disabled. [Renderer source](https://github.com/vasturiano/3d-force-graph/blob/master/src/3d-force-graph.js)

## Limits and release checks

No upstream benchmark proves smooth rendering of all 22,100 nodes and 81,941 edges on phones: the official larger-graph example is roughly 4k elements. Preserve progressive cluster/neighborhood rendering and benchmark the largest cluster before deployment. [Examples](https://github.com/vasturiano/3d-force-graph)

OrbitControls provides one-finger rotation and two-finger zoom/pan, but that does not substitute for checking browser scrolling and taps on actual mobile hardware. [Three.js control source](https://github.com/mrdoob/three.js/blob/dev/examples/jsm/controls/OrbitControls.js)

Verify responsive resizing, camera reset/focus, label readability, record selection, session invalidation, context-loss recovery, unmount cleanup and the production static export. Keep company data local to the existing authenticated API; examples' public CDN/data URLs are demonstrations only. Preserve MIT notices in distributed dependencies. No implementation or hardware benchmark was performed in this research task.

## Implementation choice

Use the direct `3d-force-graph@1.80.2` mount API rather than adding a React wrapper to the existing imperative effect. `three-spritetext@1.10.0` supplies cluster names/counts; a small translucent sprite supplies each halo. Keep the fixed worker coordinates and permission-aware loader. The direct API removes the custom raycaster, sphere/line construction and pointer gesture handling. Keep a small data-extent fit for billboard halos: the library mesh-bounds fit clipped their overview in the browser check.
