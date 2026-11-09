'use client';

import useSWR from 'swr';
import { isSwrReadUnavailable, SWR_NS, SWR_POLICY } from '@/lib/api/swr-cache';
import { AgentPicturesApi } from './picture-api';

export function isUploadedAgentPortrait(value: unknown): value is string {
  return typeof value === 'string' && /^\/api\/v1\/agents\/[0-9a-f-]{36}\/avatar\/[0-9a-f-]{36}$/.test(value);
}

export function isAgentPortrait(value: unknown): value is string {
  return isUploadedAgentPortrait(value) || (typeof value === 'string' && /^\/assets\/agents\/[a-z0-9][a-z0-9._-]*\.(?:png|webp|jpg)$/.test(value));
}

export function AgentPortrait({ src, name, size = 32 }: { src?: string | null; name: string; size?: number }) {
  const { data, error } = useSWR(isUploadedAgentPortrait(src) ? [SWR_NS.agentPictures, src] : null,
    ([, url]: [string, string]) => AgentPicturesApi.read(url), SWR_POLICY.list60s);
  if (!isAgentPortrait(src)) return null;
  const image = isUploadedAgentPortrait(src) ? (isSwrReadUnavailable(Boolean(data), error) ? undefined : data) : src;
  if (!image) return null;
  return <img src={image} alt={name} width={size} height={size}
    style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
}
