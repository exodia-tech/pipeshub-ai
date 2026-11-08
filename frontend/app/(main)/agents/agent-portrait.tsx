'use client';

export function isAgentPortrait(value: unknown): value is string {
  return typeof value === 'string' && /^\/assets\/agents\/[a-z0-9][a-z0-9._-]*\.(?:png|webp|jpg)$/.test(value);
}

export function AgentPortrait({ src, name, size = 32 }: { src?: string | null; name: string; size?: number }) {
  if (!isAgentPortrait(src)) return null;
  return <img src={src} alt={name} width={size} height={size}
    style={{ width: size, height: size, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }} />;
}
