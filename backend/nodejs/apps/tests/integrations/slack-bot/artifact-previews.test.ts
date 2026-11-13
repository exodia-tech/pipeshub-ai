import { expect } from 'chai';
import sinon from 'sinon';
import axios from 'axios';
import { uploadSlackArtifactPreview } from '../../../src/integrations/slack-bot/src/artifact-previews';
import type { TypedSlackClient } from '../../../src/integrations/slack-bot/src/helpers';

describe('Slack generated artifact previews', () => {
  afterEach(() => sinon.restore());
  it('downloads only by record identity and uploads to the original channel/thread', async () => {
    const get = sinon.stub(axios, 'get').resolves({ data: Buffer.from('image'), headers: { 'content-type': 'image/png' } });
    const uploadV2 = sinon.stub().resolves({ ok: true });
    const client = { files: { uploadV2 } } as unknown as TypedSlackClient;
    expect(await uploadSlackArtifactPreview(client, 'caller', 'chat-1', null, 'record-1', 'cat.png', 'D1', '1.1')).to.equal(true);
    expect(get.firstCall.args[0]).to.contain('/internal/chat-1/artifacts/record-1/preview');
    expect(get.firstCall.args[1]?.maxRedirects).to.equal(0);
    expect(uploadV2.firstCall.args[0]).to.include({ channel_id: 'D1', thread_ts: '1.1', filename: 'cat.png' });
  });
  it('leaves the authenticated link as fallback when access or Slack upload fails', async () => {
    sinon.stub(axios, 'get').rejects(new Error('denied'));
    const uploadV2 = sinon.stub();
    expect(await uploadSlackArtifactPreview({ files: { uploadV2 } } as unknown as TypedSlackClient, 'caller', 'chat-1', null, 'record-1', 'cat.png', 'D1', '1.1')).to.equal(false);
    expect(uploadV2.called).to.equal(false);
  });
});
