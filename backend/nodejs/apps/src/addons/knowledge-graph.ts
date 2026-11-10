import { z } from 'zod';
import { AppConfig } from '../modules/tokens_manager/config/config';
import { forwardSearch } from '../modules/enterprise_search/controller/exact_search.controller';

export const enterpriseSearchGraphSchema = z.object({
  body: z.object({ cursor: z.string().min(1).max(16384).optional() }).strict(),
});

export const graphOverview = (appConfig: AppConfig) =>
  forwardSearch(appConfig, 'graph', ['cursor'], 'Graph overview');

export const knowledgeGraphAddon = {
  id: 'knowledge-graph', path: '/graph', schema: enterpriseSearchGraphSchema, createHandler: graphOverview,
};
