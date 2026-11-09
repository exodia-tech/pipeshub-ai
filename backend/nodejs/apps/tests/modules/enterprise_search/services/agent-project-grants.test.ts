import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { KeyValueStoreService } from '../../../../src/libs/services/keyValueStore.service';
import { AgentProjectGrants, projectGrantPreview } from '../../../../src/modules/enterprise_search/services/agent-project-grants';
import { constrainProjectScheduleRequest } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';
import { buildAiChatRequest } from '../../../../src/modules/enterprise_search/utils/ai-chat-payload';
import { ProjectService } from '../../../../src/modules/projects/services/project.service';
import { ProjectDto } from '../../../../src/modules/projects/types/project.interfaces';
import { ProjectsFeature } from '../../../../src/modules/projects/utils/projects-feature';
import { AiModelsConfigRepository } from '../../../../src/modules/configuration_manager/services/aiModelsConfig.repository';
import * as admins from '../../../../src/modules/user_management/services/user-admin.service';
import * as users from '../../../../src/libs/repositories/user';

const baseAgent = { createdBy: 'owner', isActive: true, isServiceAccount: false, sendUserContext: false,
  knowledge: [{ connectorId: 'source-a' }], toolsets: [], mcpServers: [], apiToolsetTools: [], skills: [],
  models: [{ modelKey: 'key', modelName: 'model-a', provider: 'provider' }], systemPrompt: 'Draft' };
const baseProject = { _id: 'project-a', orgId: 'org-a', name: 'Project A', userId: 'owner', isArchived: false,
  visibility: 'private', knowledgeScope: { apps: ['source-a'], kb: ['collection-a'] }, tools: ['gmail.send_email'] } as ProjectDto;
const models = { llm: [{ modelKey: 'key', provider: 'provider', configuration: { model: 'model-a', apiKey: 'FAKE_TEST_ONLY' } }] };

describe('Approved project schedules', () => {
  afterEach(() => sinon.restore());
  it('binds approval to exact sources, agent, model, tenant and active admin; rejects changes and revocation', async () => {
    const values = new Map<string, string>();
    const store = Object.create(KeyValueStoreService.prototype) as KeyValueStoreService;
    sinon.stub(store, 'get').callsFake(async key => values.get(key) ?? null);
    const compareAndSet = sinon.stub(store, 'compareAndSet').callsFake(async (key, expected, value) => {
      if ((values.get(key) ?? null) !== expected) return false;
      values.set(key, String(value)); return true;
    });
    const admin = sinon.stub(admins, 'isUserOrgAdmin').resolves(true);
    const getLive = sinon.stub().resolves({ _id: 'owner', orgId: 'org-a', email: 'owner@example.invalid', kind: 'human', isDisabled: false });
    sinon.stub(users, 'getUserRepository').returns({ getLive });
    sinon.stub(ProjectsFeature, 'assertEnabled').resolves();
    let project = { ...baseProject };
    sinon.stub(ProjectService, 'assertAccess').callsFake(async (org, user, id) => {
      if (org !== 'org-a' || user !== 'owner' || id !== 'project-a') throw new Error('access denied');
      return { role: 'owner', project };
    });
    const config = sinon.stub(AiModelsConfigRepository.prototype, 'read').resolves(models);
    const grants = new AgentProjectGrants(store);
    const preview = await grants.preview('org-a', 'owner', baseAgent, 'project-a');
    assert.deepEqual(preview.projectSources, baseProject.knowledgeScope);
    assert.equal(JSON.stringify({ model: preview.model, fingerprint: preview.fingerprint }).includes('FAKE_TEST_ONLY'), false);
    await assert.rejects(grants.approve('org-a', 'owner', 'agent-a', baseAgent, 'project-a', '0'.repeat(64)));
    const grant = await grants.approve('org-a', 'owner', 'agent-a', baseAgent, 'project-a', preview.fingerprint);
    assert.equal((await grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-a', grant.id)).grant.id, grant.id);
    await assert.rejects(grants.validate('org-b', 'owner', 'agent-a', baseAgent, 'project-a', grant.id));
    await assert.rejects(grants.validate('org-a', 'other', 'agent-a', baseAgent, 'project-a', grant.id));
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-b', grant.id));
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-b', baseAgent, 'project-a', grant.id));
    project = { ...project, knowledgeScope: { apps: ['source-a', 'source-b'] } };
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-a', grant.id));
    project = { ...baseProject };
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', { ...baseAgent, knowledge: [{ connectorId: 'other' }] }, 'project-a', grant.id));
    config.resolves({ llm: [{ ...models.llm[0], provider: 'other' }] });
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-a', grant.id));
    config.resolves(models); admin.resolves(false);
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-a', grant.id));
    admin.resolves(true); getLive.resolves({ kind: 'human', isDisabled: true });
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-a', grant.id));
    getLive.resolves({ kind: 'human', isDisabled: false }); await grants.revoke('org-a', 'owner', 'agent-a');
    await assert.rejects(grants.validate('org-a', 'owner', 'agent-a', baseAgent, 'project-a', grant.id));
    compareAndSet.resolves(false);
    await assert.rejects(grants.approve('org-a', 'owner', 'agent-a', baseAgent, 'project-a', preview.fingerprint));
    await assert.rejects(grants.revoke('org-a', 'owner', 'agent-a'));
  });
  it('refuses service identities, unbounded scopes, default models and configured tools', () => {
    for (const agent of [{ ...baseAgent, isServiceAccount: true }, { ...baseAgent, sendUserContext: true },
      { ...baseAgent, mcpServers: [{}] }, { ...baseAgent, toolsets: [{}] }, { ...baseAgent, models: [] }]) {
      assert.throws(() => projectGrantPreview(agent, baseProject, models));
    }
    assert.throws(() => projectGrantPreview(baseAgent, { ...baseProject, knowledgeScope: {}, linkedKnowledgeBaseId: null }, models));
  });
  it('keeps strict project filters while overriding the project tool fallback', () => {
    const request = buildAiChatRequest({ kind: 'agent', agentKey: 'agent-a' }, {
      query: 'Draft', tools: [], agentCapabilities: { internalSearch: true, webSearch: false, deepSearch: false },
    }, { previousConversations: [], isNewConversation: true, project: baseProject });
    assert.deepEqual(request.payload.tools, ['gmail.send_email']); // Existing project helper treats [] as all.
    constrainProjectScheduleRequest(request, { modelKey: 'key', modelName: 'model-a' }, 'fingerprint');
    assert.deepEqual(request.payload.tools, []);
    assert.equal(request.payload.safeRetrievalOnly, true);
    assert.equal(request.payload.strictScope, true);
    assert.deepEqual(request.payload.filters, { apps: ['source-a'], kb: ['collection-a'] });
    assert.equal(request.payload.modelKey, 'key'); assert.equal(request.payload.modelName, 'model-a');
    assert.equal(request.payload.safeModelFingerprint, 'fingerprint');
  });
});
