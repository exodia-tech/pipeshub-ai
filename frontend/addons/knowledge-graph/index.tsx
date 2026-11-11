'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Box, Button, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useThemeAppearance } from '@/app/components/theme-provider';
import { MOBILE_HAMBURGER_GUTTER_PX } from '@/app/components/sidebar/constants';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { useSidebarWidthStore } from '@/lib/store/sidebar-width-store';
import type { PositionedNode } from './cluster-layout';
import { GraphCanvas, type GraphCamera } from './graph-canvas';
import { GraphLoading } from './loading';
import { useGraphStore } from './store';

export default function KnowledgeGraphPage() {
  const { t } = useTranslation();
  const { appearance } = useThemeAppearance();
  const mobile = useIsMobile();
  const collapsed = useSidebarWidthStore(s => s.isNavCollapsed);
  const camera = useRef<GraphCamera>(null);
  const inspector = useRef<HTMLDivElement>(null);
  const { data, phase, progress, layoutProgress, load } = useGraphStore();
  const [renderPhase, setRenderPhase] = useState<'drawing' | 'ready' | 'error'>('drawing');
  const [visibleNodes, setVisibleNodes] = useState(0);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<PositionedNode | null>(null);
  const [cluster, setCluster] = useState<number | null>(null);

  useEffect(() => { if (phase === 'idle' || phase === 'ready') void load(); }, [load, phase]);
  useEffect(() => { setSelected(null); setCluster(null); setRenderPhase('drawing'); }, [data]);
  useEffect(() => { if (inspector.current) inspector.current.scrollTop = 0; }, [selected, query]);

  const matches = useMemo(() => query.trim() && data ? data.nodes.filter(n => n.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0, 30) : [], [query, data]);
  const counts = data ? t('graph.counts', { nodes: data.nodes.length.toLocaleString(), edges: data.edges.length.toLocaleString(), clusters: data.clusters.length.toLocaleString() }) : '';
  function focusCluster(id: number) { setCluster(id); setSelected(null); setQuery(''); camera.current?.cluster(id); }

  return <Flex className="graph-addon-page" direction="column" gap="3" p={{ initial: '3', md: '5' }} style={{ minWidth: 0, width: '100%', minHeight: '100%', containerType: 'inline-size' }}>
    <Flex gap="3" align="start" justify="between" style={{ paddingLeft: mobile || collapsed ? MOBILE_HAMBURGER_GUTTER_PX : 0 }}>
      <Box style={{ minWidth: 0 }}><Flex gap="2" align="center" wrap="wrap"><Heading size={{ initial: '5', md: '6' }}>{t('graph.title')}</Heading><Badge>{t('graph.view3d')}</Badge></Flex>
      <Text as="p" size="2" color="gray" mt="1">{t('graph.overviewIntro')}</Text></Box>
      {data && <Button variant="soft" aria-label={t('graph.refresh')} title={t('graph.refresh')} style={{ minWidth: 44, height: 44, padding: 0, flexShrink: 0 }} onClick={() => void load(true)}><MaterialIcon name="refresh" size={18} /></Button>}
    </Flex>
    {(phase === 'idle' || phase === 'loading' || phase === 'layout') && <GraphLoading
      description={phase === 'loading' ? t('graph.progress', progress) : layoutProgress.total ? t('graph.layout.progress', layoutProgress) : t('graph.arranging')}
      value={phase === 'loading' ? progress.total ? Math.min(100, progress.loaded / progress.total * 100) : undefined : layoutProgress.total ? layoutProgress.done / layoutProgress.total * 100 : undefined}
    />}
    {(phase === 'error' || renderPhase === 'error') && <Flex direction="column" gap="3" role="alert"><Text color="red">{t(renderPhase === 'error' ? 'graph.rendererError' : 'graph.error')}</Text><Button style={{ alignSelf: 'flex-start', minHeight: 44 }} onClick={() => renderPhase === 'error' ? setRenderPhase('drawing') : void load(true)}>{t('graph.retry')}</Button></Flex>}
    {data && <>
      <Flex gap="3" wrap="wrap" align="center" justify="between">
        <Flex direction="column" gap="1"><Text size="2" color="gray" role="status">{counts}</Text><Text size="1" color="gray">{t('graph.metricLegend')}</Text></Flex>
        <TextField.Root aria-label={t('graph.findNode')} placeholder={t('graph.findNode')} value={query} onChange={e => setQuery(e.target.value)} style={{ minHeight: 44, width: '100%', maxWidth: 360, flex: '1 1 240px' }}>
          <TextField.Slot><MaterialIcon name="search" size={18} /></TextField.Slot>
        </TextField.Root>
      </Flex>
      {!data.nodes.length ? <Text>{t('graph.empty')}</Text> : <div className="graph-addon-layout">
        <Box className="graph-addon-canvas" style={{ minWidth: 0, position: 'relative', border: '1px solid var(--gray-6)', borderRadius: 'var(--radius-4)', overflow: 'hidden', background: 'var(--gray-2)' }}>
          {renderPhase !== 'error' && <GraphCanvas ref={camera} data={data} dark={appearance === 'dark'} label={t('graph.canvasLabel')} onCluster={focusCluster} onDetailChange={(id, count) => { setCluster(id); setVisibleNodes(count); }} onSelect={n => { setSelected(n); setCluster(n.community); }} onReady={() => setRenderPhase('ready')} onError={() => setRenderPhase('error')} />}
          {renderPhase === 'drawing' && <Flex style={{ position: 'absolute', inset: 0, background: 'var(--gray-2)' }}><GraphLoading description={t('graph.rendering')} /></Flex>}
          <Flex gap="1" style={{ position: 'absolute', right: 12, bottom: 12, padding: 4, borderRadius: 'var(--radius-3)', background: 'var(--color-panel-solid)', border: '1px solid var(--gray-6)' }}>
            <Button variant="soft" aria-label={t('graph.rotateLeft')} title={t('graph.rotateLeft')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => camera.current?.rotate(-Math.PI / 6)}><MaterialIcon name="rotate_left" size={20} /></Button>
            <Button variant="soft" aria-label={t('graph.rotateRight')} title={t('graph.rotateRight')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => camera.current?.rotate(Math.PI / 6)}><MaterialIcon name="rotate_right" size={20} /></Button>
            <Button variant="soft" aria-label={t('graph.zoomIn')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => camera.current?.zoom(0.65)}><MaterialIcon name="add" size={20} /></Button>
            <Button variant="soft" aria-label={t('graph.zoomOut')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => camera.current?.zoom(1.5)}><MaterialIcon name="remove" size={20} /></Button>
            <Button variant="soft" aria-label={t('graph.fit')} style={{ width: 44, height: 44, padding: 0 }} onClick={() => { setCluster(null); setSelected(null); camera.current?.reset(); }}><MaterialIcon name="fit_screen" size={20} /></Button>
          </Flex>
        </Box>
        <Flex ref={inspector} className="graph-addon-inspector" direction="column" gap="3" p="3" style={{ minWidth: 0, overflowY: 'auto', border: '1px solid var(--gray-6)', borderRadius: 'var(--radius-4)' }}>
          {selected && <Box p="3" style={{ background: 'var(--accent-3)', borderRadius: 'var(--radius-3)', overflowWrap: 'anywhere' }}>
            <Text as="p" weight="medium">{selected.name}</Text>
            <Text as="p" size="1" color="gray" mt="1">{t(`graph.kinds.${selected.kind}`, { defaultValue: t('graph.entity') })}</Text>
            <Text as="p" size="1" color="gray" mt="1">{t('graph.connections', { value: selected.degree.toLocaleString() })}</Text>
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
          <Text size="1" color="gray">{t('graph.connectionHint')}</Text>
        </Flex>
      </div>}
      {data.nodes.length > 0 && <><Text size="1" color="gray">{t('graph.visibleNodes', { shown: visibleNodes.toLocaleString(), total: data.nodes.length.toLocaleString() })}</Text><Text size="1" color="gray">{t('graph.controls3d')}</Text></>}
      <Text as="p" size="1" color="gray">{t('graph.coverage')} {t('graph.cacheHint')}</Text>
    </>}
  </Flex>;
}
