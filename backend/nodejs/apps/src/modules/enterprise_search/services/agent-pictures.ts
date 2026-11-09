import { randomUUID } from 'node:crypto';
import { BadRequestError, NotFoundError } from '../../../libs/errors/http.errors';
import { assertRasterImage, sharp } from '../../../libs/utils/image.utils';
import { KeyValueStoreService } from '../../../libs/services/keyValueStore.service';
import { ScheduledAgentRuntime } from './scheduled-agent-runtime';

export const AGENT_PICTURE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_STORED_BYTES = 256 * 1024;
const key = (org: string, agent: string, version: string) => `/agent-pictures/${org}/${agent}/${version}`;
export const agentPictureUrl = (agent: string, version: string) => `/api/v1/agents/${agent}/avatar/${version}`;

export async function prepareAgentPicture(buffer: Buffer): Promise<Buffer> {
  if (!buffer.length || buffer.length > AGENT_PICTURE_MAX_BYTES) throw new BadRequestError('Choose an image smaller than 5 MB.');
  assertRasterImage(buffer, ['png', 'jpeg', 'webp'], 'Choose a PNG, JPEG or WebP image.');
  try {
    const image = await sharp(buffer, { limitInputPixels: 16_000_000, animated: false })
      .rotate().resize(512, 512, { fit: 'cover' }).webp({ quality: 85 }).toBuffer();
    if (image.length > MAX_STORED_BYTES) throw new Error('Image too complex');
    return image;
  } catch { throw new BadRequestError('This image could not be processed. Choose another PNG, JPEG or WebP image.'); }
}

/** Small, processed profile images use the existing persistent KV store, behind agent read permissions. */
export class AgentPictures {
  constructor(private readonly store: Pick<KeyValueStoreService, 'get' | 'set' | 'delete'>, private readonly runtime: ScheduledAgentRuntime) {}

  async upload(org: string, agent: string, buffer: Buffer, previousUrl: unknown, headers: Record<string, string>): Promise<string> {
    const image = await prepareAgentPicture(buffer);
    const version = randomUUID();
    const url = agentPictureUrl(agent, version);
    await this.store.set(key(org, agent, version), `data:image/webp;base64,${image.toString('base64')}`);
    // shortcut: retain staged bytes after an uncertain metadata write; collect orphan versions if failed uploads accumulate.
    await this.runtime.updateAvatar(agent, url, headers);
    await this.cleanup(org, agent, previousUrl);
    return url;
  }

  async read(org: string, agent: string, version: string, currentUrl: unknown): Promise<string> {
    if (currentUrl !== agentPictureUrl(agent, version)) throw new NotFoundError('Agent picture not found.');
    const image = await this.store.get<string>(key(org, agent, version));
    if (!image) throw new NotFoundError('Agent picture not found.');
    return image;
  }

  async remove(org: string, agent: string, previousUrl: unknown, headers: Record<string, string>): Promise<void> {
    await this.runtime.updateAvatar(agent, null, headers);
    await this.cleanup(org, agent, previousUrl);
  }

  private async cleanup(org: string, agent: string, url: unknown): Promise<void> {
    const prefix = `/api/v1/agents/${agent}/avatar/`;
    if (typeof url !== 'string' || !url.startsWith(prefix)) return;
    const version = url.slice(prefix.length);
    if (!/^[0-9a-f-]{36}$/.test(version)) return;
    // Metadata already committed: cleanup failure must not turn success into a repeat upload.
    await this.store.delete(key(org, agent, version)).catch(() => undefined);
  }
}
