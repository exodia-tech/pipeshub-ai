import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import * as admins from '../../../../src/modules/user_management/services/user-admin.service';
import * as scope from '../../../../src/modules/enterprise_search/utils/scoped-request';
import * as registry from '../../../../src/modules/configuration_manager/controller/cm_controller';
import { ScheduledAgentRuntime } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';

describe('Agent delivery choices', () => {
  afterEach(() => sinon.restore());
  it('returns only bound bot names and IDs to live administrators, never credentials', async () => {
    const admin = sinon.stub(admins, 'isUserOrgAdmin').resolves(true);
    sinon.stub(scope, 'resolveSoleOrgId').resolves('org');
    const bots = sinon.stub(registry, 'getSlackBotStore').resolves({ configs: [
      { id: 'elio-bot', name: 'Elio', agentId: 'elio', botToken: 'FAKE_TEST_ONLY', signingSecret: 'FAKE_TEST_ONLY' },
      { id: 'other-bot', name: 'Other', agentId: 'other', botToken: 'FAKE_TEST_ONLY', signingSecret: 'FAKE_TEST_ONLY' },
    ] });
    const runtime = Object.create(ScheduledAgentRuntime.prototype) as ScheduledAgentRuntime;
    assert.deepEqual(await runtime.deliveryOptions('org', 'owner', 'elio'), { canManage: true, bots: [{ id: 'elio-bot', name: 'Elio' }] });
    bots.resetHistory(); admin.resolves(false);
    assert.deepEqual(await runtime.deliveryOptions('org', 'owner', 'elio'), { canManage: false, bots: [] });
    assert.equal(bots.callCount, 0);
    admin.resolves(true);
    assert.deepEqual(await runtime.deliveryOptions('foreign', 'owner', 'elio'), { canManage: false, bots: [] });
    assert.equal(bots.callCount, 0);
  });
});
