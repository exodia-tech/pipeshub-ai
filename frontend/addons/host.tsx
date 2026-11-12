'use client';

import { lazy, Suspense } from 'react';
import { notFound } from 'next/navigation';
import { LoadingScreen } from '@/app/components/ui/auth-guard';
import { addons } from './registry';

const views = new Map(addons.map(addon => {
  const View = lazy(addon.load);
  return [addon.id, <View key={addon.id} />];
}));

export function AddonPage({ id }: { id: string }) {
  const view = views.get(id);
  if (!view) notFound();
  return <Suspense fallback={<LoadingScreen />}>{view}</Suspense>;
}
