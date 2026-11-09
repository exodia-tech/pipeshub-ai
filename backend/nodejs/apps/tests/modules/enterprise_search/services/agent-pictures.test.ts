import { strict as assert } from 'node:assert';
import sinon from 'sinon';
import { sharp } from '../../../../src/libs/utils/image.utils';
import { KeyValueStoreService } from '../../../../src/libs/services/keyValueStore.service';
import { AgentPictures, agentPictureUrl, prepareAgentPicture, AGENT_PICTURE_MAX_BYTES } from '../../../../src/modules/enterprise_search/services/agent-pictures';
import { ScheduledAgentRuntime } from '../../../../src/modules/enterprise_search/services/scheduled-agent-runtime';

describe('Private agent pictures', () => {
  const agent = 'e6ed44ce-65cc-42db-95bc-5db456f5f450';
  const version = '120d1a70-989a-499b-8e41-170b2a07a820';
  const input = () => sharp({ create: { width: 1000, height: 600, channels: 3, background: '#2266ff' } }).jpeg().toBuffer();
  afterEach(() => sinon.restore());
  it('re-encodes raster bytes to bounded square WebP and rejects fake, oversized and decompression-heavy images', async () => {
    const result = await prepareAgentPicture(await input());
    const metadata = await sharp(result).metadata();
    assert.equal(metadata.format, 'webp'); assert.equal(metadata.width, 512); assert.equal(metadata.height, 512);
    assert.equal(metadata.exif, undefined); assert.ok(result.length <= 256 * 1024);
    for (const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.alloc(0), Buffer.alloc(AGENT_PICTURE_MAX_BYTES + 1)]) await assert.rejects(prepareAgentPicture(bytes));
    const huge = await sharp({ create: { width: 4100, height: 4100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await assert.rejects(prepareAgentPicture(huge));
  });
  it('requires the active version and caller organization, and never deletes the old picture after a failed metadata update', async () => {
    const values = new Map<string, string>([[`/agent-pictures/org/${agent}/${version}`, 'old image']]);
    const store = Object.create(KeyValueStoreService.prototype) as KeyValueStoreService;
    const get = sinon.stub(store, 'get').callsFake(async key => values.get(key));
    sinon.stub(store, 'set').callsFake(async (key, value) => { values.set(key, String(value)); });
    const remove = sinon.stub(store, 'delete').callsFake(async key => { values.delete(key); });
    const runtime = Object.create(ScheduledAgentRuntime.prototype) as ScheduledAgentRuntime;
    const update = sinon.stub(runtime, 'updateAvatar').rejects(new Error('metadata unavailable'));
    const pictures = new AgentPictures(store, runtime);
    const url = agentPictureUrl(agent, version);
    assert.equal(await pictures.read('org', agent, version, url), 'old image');
    await assert.rejects(pictures.read('foreign-org', agent, version, url));
    get.resetHistory();
    await assert.rejects(pictures.read('org', agent, version, null)); assert.equal(get.callCount, 0);
    await assert.rejects(pictures.upload('org', agent, await input(), url, {})); assert.equal(remove.callCount, 0);
    await assert.rejects(pictures.remove('org', agent, url, {})); assert.equal(remove.callCount, 0);
    update.resolves();
    await pictures.remove('org', agent, url, {});
    assert.equal(remove.callCount, 1); assert.ok(update.calledBefore(remove));
  });
});
