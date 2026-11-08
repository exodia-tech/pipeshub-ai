import { strict as assert } from 'node:assert';
import { createAgentSchema, updateAgentSchema } from '../../../../src/modules/enterprise_search/validators/es_validators';

describe('agent portrait gateway validation', () => {
  const params = { agentKey: 'e6ed44ce-65cc-42db-95bc-5db456f5f450' };
  const avatarUrl = '/assets/agents/elio-v1.png';
  it('forwards portraits on both creation and later partial edits', () => {
    assert.equal(createAgentSchema.parse({ body: { name: 'Elio', avatarUrl } }).body.avatarUrl, avatarUrl);
    assert.equal(updateAgentSchema.parse({ params, body: { avatarUrl } }).body.avatarUrl, avatarUrl);
    assert.equal(updateAgentSchema.parse({ params, body: { avatarUrl: null } }).body.avatarUrl, null);
  });
  it('rejects external and traversing portrait URLs on partial edits', () => {
    for (const url of ['https://example.com/a.png', '/assets/agents/../../a.png', 'data:image/png;base64,eA==']) {
      assert.equal(updateAgentSchema.safeParse({ params, body: { avatarUrl: url } }).success, false);
    }
  });
});
