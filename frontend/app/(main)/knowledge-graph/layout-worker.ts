import { clusterLayout } from './cluster-layout';
import type { GraphData } from './api';

self.onmessage = (event: MessageEvent<GraphData>) => {
  try { self.postMessage({ result: clusterLayout(event.data) }); }
  catch { self.postMessage({ error: true }); }
};
