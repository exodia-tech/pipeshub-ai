import { describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiClient: { post } }));
import { GraphApi } from '../api';

describe('Graph API', () => {
  it('uses the signed-in API client and bounds the neighborhood without client-supplied identity', async () => {
    post.mockResolvedValue({ data: { records: [], relatedEntities: [] } });
    await GraphApi.neighbors({ entityId: 'topic-1', entityType: 'topic', name: 'Example' });
    expect(post).toHaveBeenCalledWith('/api/v1/search/entities/neighbors', {
      entityId: 'topic-1', entityType: 'topic', recordLimit: 6, relatedLimit: 4,
    });
  });
});
