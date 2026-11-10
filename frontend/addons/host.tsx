'use client';

import { lazy, Suspense } from 'react';
import { notFound } from 'next/navigation';
import { LoadingScreen } from '@/app/components/ui/auth-guard';
import { addons } from './registry';

const views = new Map(addons.map(addon => [addon.id, lazy(addon.load)]));

export function AddonPage({ id }: { id: string }) {
  const View = views.get(id);
  if (!View) notFound();
  return <Suspense fallback={<LoadingScreen />}><View /></Suspense>;
}
