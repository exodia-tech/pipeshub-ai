import { knowledgeGraphManifest } from './knowledge-graph/manifest';

export const addons = [
  { ...knowledgeGraphManifest, load: () => import('./knowledge-graph') },
];
