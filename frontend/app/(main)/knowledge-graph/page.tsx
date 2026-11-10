'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Flex, Heading, Spinner, Text, TextField } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useThemeAppearance } from '@/app/components/theme-provider';
import { MOBILE_HAMBURGER_GUTTER_PX } from '@/app/components/sidebar/constants';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { useSidebarWidthStore } from '@/lib/store/sidebar-width-store';
import { loadGraph } from './api';
import type { ClusteredGraph, PositionedNode } from './cluster-layout';
import { GraphCanvas, type GraphCamera } from './graph-canvas';

export default function KnowledgeGraphPage() {
  const { t } = useTranslation();
  const { appearance } = useThemeAppearance();
  const mobile = useIsMobile();
  const collapsed = useSidebarWidthStore(s => s.isNavCollapsed);
  const camera = useRef<GraphCamera>(null);
  const [data, setData] = useState<ClusteredGraph | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const [phase, setPhase] = useState<'loading' | 'layout' | 'ready' | 'error' | 'rendererError'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PositionedNode | null>(null);
  const [cluster, setCluster] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let worker: Worker | undefined;
    setData(null); setSelected(null); setCluster(null); setPhase('loading'); setProgress({ loaded: 0, total: 0 });
    void loadGraph(controller.signal, (loaded, total) => setProgress({ loaded, total })).then(graph => {
      if (controller.signal.aborted) return;
      setPhase('layout');
      worker = new Worker(new URL('./layout-worker.ts', import.meta.url));
      worker.onmessage = ({ data: message }: MessageEvent<{ result?: ClusteredGraph; error?: boolean }>) => {
        if (controller.signal.aborted) return;
        if (message.result) { setData(message.result); setPhase('ready'); } else setPhase('error');
        worker?.terminate();
      };
      worker.onerror = () => { if (!controller.signal.aborted) setPhase('error'); worker?.terminate(); };
      worker.postMessage(graph);
    }).catch(() => { if (!controller.signal.aborted) setPhase('error'); });
    return () => { controller.abort(); worker?.terminate(); };
  }, [attempt]);

  const matches = useMemo(() => query.trim() && data ? data.nodes.filter(n => n.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 30) : [], [query, data]);
  const counts = data ? t('graph.counts', { nodes: data.nodes.length.toLocaleString(), edges: data.edges.length.toLocaleString(), clusters: data.clusters.length.toLocaleString() }) : '';
  function focusCluster(id: number) { setCluster(id); setSelected(null); setQuery(''); camera.current?.cluster(id); }

  return <Flex direction="column" gap="3" p={{ initial: '3', md: '5' }} style={{ minWidth: 0, width: '100%', height: '100%', overflowY: 'auto' }}>
    <Box style={{ paddingLeft: mobile || collapsed ? MOBILE_HAMBURGER_GUTTER_PX : 0 }}>
      <Heading size={{ initial: '5', md: '6' }}>{t('graph.title')}</Heading>
      <Text as="p" size="2" color="gray" mt="1">{t('graph.overviewIntro')}</Text>
    </Box>
    {(phase === 'loading' || phase === 'layout') && <Flex gap="2" align="center" role="status" py="4"><Spinner /><Text size="2">{phase === 'layout' ? t('graph.arranging') : t('graph.progress', progress)}</Text></Flex>}
    {(phase === 'error' || phase === 'rendererError') && <Flex direction="column" gap="3" role="alert"><Text color="red">{t(phase === 'rendererError' ? 'graph.rendererError' : 'graph.error')}</Text><Button style={{ alignSelf: 'flex-start', minHeight: 44 }} onClick={() => setAttempt(a => a + 1)}>{t('graph.retry')}</Button></Flex>}
    {data && <>
      <Flex gap="3" direction={{ initial: 'column', md: 'row' }} align={{ initial: 'stretch', md: 'center' }} justify="between">
        <Text size="2" color="gray" role="status">{counts}</Text>
        <TextField.Root aria-label={t('graph.findNode')} placeholder={t('graph.findNode')} value={query} onChange={e => setQuery(e.target.value)} style={{ minHeight: 44, width: mobile ? '100%' : 280 }}>
          <TextField.Slot><MaterialIcon name="search" size={18} /></TextField.Slot>
        </TextField.Root>
      </Flex>
      {!data.nodes.length ? <Text>{t('graph.empty')}</Text> : <Flex gap="3" direction={{ initial: 'column', md: 'row' }} style={{ flex: 1, minHeight: mobile ? undefined : 520 }}>
        <Box style={{ flex: 1, minWidth: 0, position: 'relative', height: mobile ? '55dvh' : '100%', minHeight: 340, border: '1px solid var(--gray-6)', borderRadius: 'var(--radius-4)', overflow: 'hidden', background: 'var(--gray-2)' }}>
          {phase !== 'rendererError' && <GraphCanvas ref={camera} data={data} dark={appearance === 'dark'} label={t('graph.canvasLabel')} onSelect={n => { setSelected(n); setCluster(n.community); }} onError={() => setPhase('rendererError')} />}
          <Flex gap="1" style={{ position: 'absolute', right: 12, bottom: 12, padding: 4, borderRadius: 'var(--radius-3)', background: 'var(--color-panel-solid)', border: '1px solid var(--gray-6)' }}>
            <Button variant="soft" aria-label={t('graph.zoomIn')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => camera.current?.zoom(0.65)}><MaterialIcon name="add" size={20} /></Button>
            <Button variant="soft" aria-label={t('graph.zoomOut')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => camera.current?.zoom(1.5)}><MaterialIcon name="remove" size={20} /></Button>
            <Button variant="soft" aria-label={t('graph.fit')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => { setCluster(null); setSelected(null); camera.current?.reset(); }}><MaterialIcon name="fit_screen" size={20} /></Button>
          </Flex>
        </Box>
        <Flex direction="column" gap="3" style={{ width: mobile ? '100%' : 260, flexShrink: 0, maxHeight: mobile ? undefined : '70dvh', overflowY: mobile ? undefined : 'auto' }}>
          {selected && <Box p="3" style={{ background: 'var(--accent-3)', borderRadius: 'var(--radius-3)', overflowWrap: 'anywhere' }}>
            <Text as="p" weight="medium">{selected.name}</Text>
            <Text as="p" size="1" color="gray" mt="1">{t(`graph.kinds.${selected.kind}`, { defaultValue: t('graph.entity') })}</Text>
            {selected.recordId && <Button asChild mt="3" style={{ minHeight: 44 }}><a href={selected.kind === 'record' ? `/record/?recordId=${encodeURIComponent(selected.recordId)}` : `/knowledge-base/?nodeType=${encodeURIComponent(selected.kind)}&nodeId=${encodeURIComponent(selected.recordId)}`}>{t('graph.openRecord')}</a></Button>}
          </Box>}
          {query.trim() ? <><Text weight="medium" size="2">{t('graph.searchResults')}</Text>{!matches.length && <Text size="2" color="gray">{t('graph.noResults')}</Text>}{matches.map(n => <Button key={n.id} variant="ghost" onClick={() => { setSelected(n); setCluster(n.community); camera.current?.node(n.id); }} style={{ boxSizing: 'border-box', margin: 0, width: '100%', flexShrink: 0, whiteSpace: 'normal', minHeight: 44, height: 'auto', padding: '10px 12px', justifyContent: 'flex-start', textAlign: 'left', overflowWrap: 'anywhere' }}>{n.name}</Button>)}</> : <>
            <Text weight="medium" size="2">{t('graph.clusters')}</Text>
            {data.clusters.map(c => <Button key={c.id} variant={cluster === c.id ? 'soft' : 'ghost'} aria-pressed={cluster === c.id} onClick={() => focusCluster(c.id)} style={{ boxSizing: 'border-box', margin: 0, width: '100%', flexShrink: 0, minHeight: 48, height: 'auto', padding: '10px 12px', justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left' }}>
              <span aria-hidden="true" style={{ width: 9, height: 9, flexShrink: 0, borderRadius: '50%', background: c.color }} />
              <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{c.isolated ? t('graph.unconnected') : c.name}</span><Text size="1" color="gray">{c.count.toLocaleString()}</Text>
            </Button>)}
          </>}
          <Text size="1" color="gray">{t('graph.clusterHint')}</Text>
        </Flex>
      </Flex>}
      <Text as="p" size="1" color="gray">{t('graph.coverage')}</Text>
    </>}
  </Flex>;
}
