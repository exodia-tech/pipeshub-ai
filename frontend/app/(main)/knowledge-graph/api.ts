import { apiClient } from '@/lib/api';

export interface Entity {
  entityId: string;
  entityType: string;
  name: string;
  sharedRecords?: number;
}

export interface GraphRecord {
  recordId: string;
  recordName: string | null;
  recordType: string | null;
  app?: string;
  webUrl?: string | null;
}

export interface Neighborhood {
  records: GraphRecord[];
  relatedEntities: Entity[];
  nextCursor?: string;
  note?: string;
  relatedNote?: string;
}

export const GraphApi = {
  async search(query: string): Promise<Entity[]> {
    const { data } = await apiClient.post<{ results: Entity[] }>('/api/v1/search/entities', { query, limit: 20 });
    return data.results;
  },
  async neighbors(entity: Entity): Promise<Neighborhood> {
    const { data } = await apiClient.post<Neighborhood>('/api/v1/search/entities/neighbors', {
      entityId: entity.entityId, entityType: entity.entityType, recordLimit: 6, relatedLimit: 4,
    });
    return data;
  },
};
