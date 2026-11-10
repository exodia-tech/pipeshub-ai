# Spatial knowledge graph layout

Research date: 2026-11-10. Target snapshot supplied by the implementation task: 22,090 nodes, 81,941 edges, 36 Louvain communities. No document vectors are currently exported to this view. This note recommends a design; it does not report a performance benchmark or a user study of this application.

## Recommendation

Replace the grid with a **two-level topology map**: spatialize the weighted graph of communities, then place each community's locally laid-out members around that community's position. Keep the existing Sigma WebGL renderer, Graphology, Louvain and ForceAtlas2 dependencies. Show communities and their aggregate connections at overview scale; expand into members and incident connections when focusing or zooming. This is an engineering synthesis of force-directed spatialization and hierarchical graph navigation, not a new embedding algorithm.

Call this a “relationship map” or “graph layout.” Its positions encode connectivity under a layout model, not semantic text similarity. Community distance is suggestive, not a calibrated similarity score. A community is also not necessarily a topic: Louvain identifies structure in the supplied edges.

## Evidence and alternatives

| Approach | What the primary source supports | Fit for this graph |
| --- | --- | --- |
| ForceAtlas2 | Nodes repel and edges attract; edge weights, gravity, degree-dependent repulsion and Barnes–Hut approximation affect the resulting spatialization. LinLog can emphasize communities. The paper describes a continuous graph layout, not a semantic embedding. | Already installed; directly uses the relationships available today. Apply it to 36 aggregate nodes and to local graphs rather than promising an immediately readable drawing of every edge. [Jacomy et al., 2014](https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0098679) |
| UMAP | Learns a low-dimensional representation of metric data using local neighborhood structure; output dimension can be 2 or 3. | Appropriate once actual document/entity vectors or justified pairwise distances exist. Passing arbitrary graph coordinates or labels would not create a semantic map. [McInnes, Healy and Melville](https://arxiv.org/abs/1802.03426) |
| LargeVis | Builds an approximate nearest-neighbor graph from high-dimensional data, then optimizes a probabilistic low-dimensional layout with negative sampling. | A useful vector-visualization precedent, but another pipeline and dependency are unnecessary for the current edge-based view. Its published scaling results are not browser benchmarks for this application. [Tang et al., 2016](https://arxiv.org/abs/1602.00370) |
| Multilevel force layout | Coarsens a graph, draws a small graph, then prolongs/refines positions toward the original graph. | Supports starting from aggregate structure. A single Louvain aggregate level plus bounded local layouts is a simpler adaptation, not an implementation of the paper's full recursive algorithm. [Walshaw, 2003](https://jgaa-v5.cs.brown.edu/index.php/jgaa/article/view/paper70) |
| Hierarchical navigation | ASK-GraphView builds a cluster hierarchy and lets users expand clusters interactively, with filtering and labeling. | Supports overview-to-detail navigation instead of displaying the full edge set at all scales. Our two-level view is shallower than ASK-GraphView. [Abello, van Ham and Krishnan, 2006](https://research.tue.nl/en/publications/ask-graphview-a-large-scale-graph-visualization-system/) |

UMAP's `n_neighbors` balances local and broader structure; `min_dist` changes packing. Therefore apparent islands and gaps depend on parameters. The authors' documentation explicitly warns that UMAP does not fully preserve density and can create false cluster tears. Do not interpret inter-island distance as precise semantic distance, infer cluster importance from area, or infer true disconnectedness from a visible gap. [Parameter documentation](https://umap-learn.readthedocs.io/en/latest/parameters.html), [clustering caveats](https://umap-learn.readthedocs.io/en/latest/clustering.html).

If vectors become available, a separate offline comparison could start with cosine distance, `n_neighbors` 15/30/50, `min_dist` 0.1/0.3 and `n_components=2`, with a fixed seed and model/version metadata. These are proposed comparison settings, not validated defaults. Compare original-space neighbors with projected neighbors before making semantic claims.

## Concrete implementation constraints

The following values are starting settings for this application, not values experimentally validated by the papers:

1. Aggregate every cross-community edge into an undirected community-pair weight; retain the original edge direction/type for detail. Keep the relationship count as the stored weight. `edgeWeightInfluence=0.5` makes its attraction sublinear (square-root weighting); do not also transform the count unintentionally. Normalizing by community volume would instead encode relative association and can elevate weak links between tiny communities. That is a separate modeling choice.
2. Initialize the aggregate nodes with deterministic, distinct nonzero positions. Start with roughly 200–400 ForceAtlas2 iterations, `gravity=1`, `scalingRatio=8`, `edgeWeightInfluence=0.5`, `linLogMode=true`. With only 36 nodes, exact repulsion is reasonable. If using `adjustSizes`, use graph-space community footprint radii rather than screen-space glyph sizes. Strong gravity can limit drift but may compress disconnected islands, so inspect it on unequal communities. Keep positions stable across pan, hover and selection.
3. Retain each local graph's edges. Start with the existing 100 local iterations and Barnes–Hut enabled for large communities; center the result and scale it to a bounded community radius. Give disconnected or edgeless members deterministic positions so they remain visible. A radius proportional to the square root of member count is a display-space heuristic, not an inferred distance.
4. Separate overlapping community footprints using their radii and padding after aggregate layout. Preserve the organic arrangement as much as possible; do not remap it into rows. This separation distorts layout distances, which is another reason not to show a numerical distance legend.
5. Cache the computed layout and use the existing worker path where applicable. Do not recompute on camera events. Overview renders aggregates; detail renders focused members and selected neighbors, with all records still searchable. A direct search hit must focus the correct community and reveal the node.

Graphology requires starting `x`/`y` attributes and warns against initializing every node at the origin. Its API supports explicit iterations, edge-weight getters, inferred settings and worker lifecycle management; Barnes–Hut approximates repulsion. Confirm exact options against the installed 0.10.1 implementation, since online documentation can differ. [Official Graphology ForceAtlas2 documentation](https://graphology.github.io/standard-library/layout-forceatlas2.html).

## 2D and 3D tradeoffs

Research does **not** show that 3D is categorically worse. Ware and Franck found benefits for graph path tracing from motion and stereo cues; Ware and Mitchell subsequently studied high-resolution stereoscopic graph displays. Those conditions do not establish the same benefit for a static perspective image or this browser/mobile interface. [Ware and Franck, 1996](https://scholars.unh.edu/ccom/939/), [authors' research overview and Ware–Mitchell reference](https://vislab-ccom.unh.edu/projects/networks/).

Occlusion remains a real 3D discovery/access problem, with a substantial literature devoted to managing it. [Elmqvist and Tsigas, 2008](https://research.chalmers.se/en/publication/72508). The initial 2D implementation was a scope decision, not a claim of measured 2D superiority. The user subsequently explicitly requested 3D. The implementation now uses Three.js orbit controls and a worker running d3-force-3d on the weighted quotient graph and local communities. It retains search, cluster focus, neighborhood selection, reset and an accessible detail panel. Labels follow the camera and respect depth occlusion; rotation buttons expose hidden nodes. Dense clusters show detailed links on selection to avoid a hairball. Compare discovery and path-tracing tasks on actual desktop and mobile hardware before claiming an empirical usability advantage. See the [renderer documentation](https://threejs.org/docs/) and [3D force layout implementation](https://github.com/vasturiano/d3-force-3d).

## Verification needed in the implementation

Check finite coordinates and deterministic output; retain node/edge totals and community membership; test a disconnected graph, an isolated node, and heavily unequal community sizes. Visually check the full real snapshot at overview and focused scale, both color themes, a search hit and a narrow viewport. Measure actual layout time and interaction responsiveness before claiming scale or speed improvements.

Skipped: exporting vectors and adding UMAP/LargeVis dependencies. Risk: layout geometry and community labels can suggest meaning stronger than the underlying relationships justify; keep the UI wording honest.
