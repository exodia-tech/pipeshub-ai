'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Box, Button, Callout, Flex, Heading, IconButton, Popover, ScrollArea, Separator, Text, TextField, Tooltip } from '@radix-ui/themes';
import { useTranslation } from 'react-i18next';
import { MaterialIcon } from '@/app/components/ui/MaterialIcon';
import { useThemeAppearance } from '@/app/components/theme-provider';
import { MOBILE_HAMBURGER_GUTTER_PX } from '@/app/components/sidebar/constants';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { SidebarExpandButton } from '@/app/components/sidebar/sidebar-expand-button';
import type { PositionedNode } from './cluster-layout';
import { GraphCanvas, type GraphCamera } from './graph-canvas';
import { GraphLoading } from './loading';
import { useGraphStore } from './store';

export default function KnowledgeGraphPage() {
  const { t } = useTranslation();
  const { appearance } = useThemeAppearance();
  const mobile = useIsMobile();
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

  return <Flex className="graph-addon-page" direction="column" style={{ minWidth: 0, width: '100%', minHeight: '100%', containerType: 'inline-size' }}>
    <Flex align="center" justify="between" gap="3" px="3" style={{ minHeight: 48, borderBottom: '1px solid var(--olive-3)', paddingLeft: mobile ? MOBILE_HAMBURGER_GUTTER_PX : undefined }}>
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <SidebarExpandButton placement="inline" />
        <Heading size="2" weight="medium">{t('graph.title')}</Heading>
        <Badge color="gray" variant="soft" size="1">{t('graph.view3d')}</Badge>
      </Flex>
      {data && <Tooltip content={t('graph.refresh')}><IconButton variant="ghost" color="gray" loading={phase === 'loading' || phase === 'layout'} aria-label={t('graph.refresh')} style={{ width: 44, height: 44, margin: 0, flexShrink: 0 }} onClick={() => void load(true)}><MaterialIcon name="refresh" size={18} /></IconButton></Tooltip>}
    </Flex>
    <Flex direction="column" gap="3" p={{ initial: '3', md: '4' }} style={{ minWidth: 0, flex: 1 }}>
      <Text as="p" size="2" color="gray">{t('graph.overviewIntro')}</Text>
      {!data && (phase === 'idle' || phase === 'loading' || phase === 'layout') && <GraphLoading
        description={phase === 'loading' ? progress.total ? t('graph.progress', progress) : undefined : phase === 'layout' ? layoutProgress.total ? t('graph.layout.progress', layoutProgress) : t('graph.arranging') : undefined}
        value={phase === 'loading' ? progress.total ? Math.min(100, progress.loaded / progress.total * 100) : undefined : layoutProgress.total ? layoutProgress.done / layoutProgress.total * 100 : undefined}
      />}
      {data && (phase === 'loading' || phase === 'layout') && <Text size="1" color="gray" role="status">{t('graph.updating')}</Text>}
      {(phase === 'error' || renderPhase === 'error') && <Callout.Root color={data && renderPhase !== 'error' ? 'amber' : 'red'} variant="surface" size="1" role="alert">
        <Callout.Icon><MaterialIcon name="info" size={16} /></Callout.Icon>
        <Flex align="center" justify="between" gap="3" wrap="wrap" style={{ flex: 1, minWidth: 0 }}>
          <Callout.Text>{t(renderPhase === 'error' ? 'graph.rendererError' : data ? 'graph.refreshError' : 'graph.error')}</Callout.Text>
          <Button variant="ghost" color="gray" size="1" style={{ minHeight: 44, margin: 0, flexShrink: 0 }} onClick={() => renderPhase === 'error' ? setRenderPhase('drawing') : void load(true)}><MaterialIcon name="refresh" size={14} />{t('graph.retry')}</Button>
        </Flex>
      </Callout.Root>}
      {data && <>
        <Flex gap="3" wrap="wrap" align="center" justify="between">
          <Text size="2" color="gray" role="status" style={{ fontVariantNumeric: 'tabular-nums' }}>{counts}</Text>
          <TextField.Root size="2" aria-label={t('graph.findNode')} placeholder={t('graph.findNode')} value={query} onChange={e => setQuery(e.target.value)} style={{ minHeight: 44, width: '100%', maxWidth: mobile ? '100%' : 320, flex: '1 1 220px' }}>
            <TextField.Slot><MaterialIcon name="search" size={16} /></TextField.Slot>
          </TextField.Root>
        </Flex>
        {!data.nodes.length ? <Flex direction="column" align="center" justify="center" gap="3" style={{ minHeight: 320 }}><MaterialIcon name="hub" size={32} color="var(--gray-9)" /><Text size="2" color="gray">{t('graph.empty')}</Text></Flex> : <div className="graph-addon-layout">
          <Box className="graph-addon-canvas" style={{ minWidth: 0, position: 'relative', border: '1px solid var(--gray-5)', borderRadius: 'var(--radius-3)', overflow: 'hidden', background: 'var(--gray-2)' }}>
            {renderPhase !== 'error' && <GraphCanvas ref={camera} data={data} dark={appearance === 'dark'} label={t('graph.canvasLabel')} onCluster={focusCluster} onDetailChange={(id, count) => { setCluster(id); setVisibleNodes(count); }} onSelect={n => { setSelected(n); setCluster(n.community); }} onReady={() => setRenderPhase('ready')} onError={() => setRenderPhase('error')} />}
            {renderPhase === 'drawing' && <Flex style={{ position: 'absolute', inset: 0, background: 'var(--gray-2)' }}><GraphLoading description={t('graph.rendering')} /></Flex>}
            <Flex align="center" gap="1" role="toolbar" aria-label={t('graph.canvasLabel')} style={{ position: 'absolute', right: 12, bottom: 12, padding: 4, borderRadius: 'var(--radius-3)', background: 'var(--color-panel-solid)', border: '1px solid var(--gray-5)', boxShadow: 'var(--shadow-2)' }}>
              <Tooltip content={t('graph.rotateLeft')}><IconButton variant="ghost" color="gray" disabled={renderPhase !== 'ready'} aria-label={t('graph.rotateLeft')} style={{ width: 44, height: 44, margin: 0 }} onClick={() => camera.current?.rotate(-Math.PI / 6)}><MaterialIcon name="rotate_left" size={18} /></IconButton></Tooltip>
              <Tooltip content={t('graph.rotateRight')}><IconButton variant="ghost" color="gray" disabled={renderPhase !== 'ready'} aria-label={t('graph.rotateRight')} style={{ width: 44, height: 44, margin: 0 }} onClick={() => camera.current?.rotate(Math.PI / 6)}><MaterialIcon name="rotate_right" size={18} /></IconButton></Tooltip>
              <Tooltip content={t('graph.zoomIn')}><IconButton variant="ghost" color="gray" disabled={renderPhase !== 'ready'} aria-label={t('graph.zoomIn')} style={{ width: 44, height: 44, margin: 0 }} onClick={() => camera.current?.zoom(0.65)}><MaterialIcon name="add" size={18} /></IconButton></Tooltip>
              <Tooltip content={t('graph.zoomOut')}><IconButton variant="ghost" color="gray" disabled={renderPhase !== 'ready'} aria-label={t('graph.zoomOut')} style={{ width: 44, height: 44, margin: 0 }} onClick={() => camera.current?.zoom(1.5)}><MaterialIcon name="remove" size={18} /></IconButton></Tooltip>
              <Tooltip content={t('graph.fit')}><IconButton variant="ghost" color="gray" disabled={renderPhase !== 'ready'} aria-label={t('graph.fit')} style={{ width: 44, height: 44, margin: 0 }} onClick={() => { setCluster(null); setSelected(null); camera.current?.reset(); }}><MaterialIcon name="fit_screen" size={18} /></IconButton></Tooltip>
            </Flex>
          </Box>
          <Flex className="graph-addon-inspector" direction="column" style={{ minWidth: 0, overflow: 'hidden', border: '1px solid var(--gray-5)', borderRadius: 'var(--radius-3)', background: 'var(--color-panel-solid)' }}>
            <Flex align="center" justify="between" gap="2" px="3" py="3">
              <Text weight="medium" size="2">{t(query.trim() ? 'graph.searchResults' : 'graph.clusters')}</Text>
              <Badge color="gray" variant="soft">{query.trim() ? matches.length : data.clusters.length}</Badge>
            </Flex>
            <Separator size="4" />
            <ScrollArea ref={inspector} type="auto" scrollbars="vertical" style={{ flex: 1, minHeight: 0 }}>
              <Flex direction="column" gap="1" p="2">
                {selected && <Box p="3" mb="2" style={{ background: 'var(--gray-3)', borderRadius: 'var(--radius-3)', overflowWrap: 'anywhere' }}>
                  <Text as="p" size="2" weight="medium">{selected.name}</Text>
                  <Text as="p" size="1" color="gray" mt="1">{t(`graph.kinds.${selected.kind}`, { defaultValue: t('graph.entity') })}</Text>
                  <Text as="p" size="1" color="gray" mt="1">{t('graph.connections', { value: selected.degree.toLocaleString() })}</Text>
                  {selected.recordId && <Button asChild mt="3" variant="soft" size="1" style={{ minHeight: 44 }}><a href={selected.kind === 'record' ? `/record/?recordId=${encodeURIComponent(selected.recordId)}` : `/knowledge-base/?nodeType=${encodeURIComponent(selected.kind)}&nodeId=${encodeURIComponent(selected.recordId)}`}>{t('graph.openRecord')}</a></Button>}
                </Box>}
                {query.trim() ? <>
                  {!matches.length && <Text size="2" color="gray" style={{ padding: 'var(--space-2)' }}>{t('graph.noResults')}</Text>}
                  {matches.map(n => <Tooltip key={n.id} content={n.name}><Button variant="ghost" color="gray" onClick={() => { setSelected(n); setCluster(n.community); camera.current?.node(n.id); }} style={{ boxSizing: 'border-box', margin: 0, width: '100%', flexShrink: 0, minHeight: 44, justifyContent: 'flex-start', textAlign: 'left' }}><Text size="2" truncate>{n.name}</Text></Button></Tooltip>)}
                </> : data.clusters.map(c => <Tooltip key={c.id} content={c.isolated ? t('graph.unconnected') : c.name}><Button variant={cluster === c.id ? 'soft' : 'ghost'} color={cluster === c.id ? undefined : 'gray'} aria-pressed={cluster === c.id} onClick={() => focusCluster(c.id)} style={{ boxSizing: 'border-box', margin: 0, width: '100%', flexShrink: 0, minHeight: 44, padding: '0 var(--space-2)', justifyContent: 'flex-start', textAlign: 'left' }}>
                  <span aria-hidden="true" style={{ width: 7, height: 7, flexShrink: 0, borderRadius: '50%', background: c.color }} />
                  <Text size="2" truncate style={{ flex: 1 }}>{c.isolated ? t('graph.unconnected') : c.name}</Text>
                  <Text size="1" color="gray" style={{ flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>{c.count.toLocaleString()}</Text>
                </Button></Tooltip>)}
              </Flex>
            </ScrollArea>
          </Flex>
        </div>}
        {data.nodes.length > 0 && renderPhase === 'ready' && <Flex align="center" justify="between" gap="2">
          <Text size="1" color="gray">{t('graph.visibleNodes', { shown: visibleNodes.toLocaleString(), total: data.nodes.length.toLocaleString() })}</Text>
          <Popover.Root>
            <Popover.Trigger><IconButton variant="ghost" color="gray" aria-label={t('graph.controls3d')} style={{ width: 44, height: 44, margin: 0, flexShrink: 0 }}><MaterialIcon name="info" size={16} /></IconButton></Popover.Trigger>
            <Popover.Content size="2" aria-label={t('graph.title')} style={{ width: 360, maxWidth: 'calc(100vw - 32px)' }}>
              <Flex direction="column" gap="2">
                <Text size="2">{t('graph.controls3d')}</Text>
                <Text size="1" color="gray">{t('graph.metricLegend')}</Text>
                <Text size="1" color="gray">{t('graph.coverage')} {t('graph.cacheHint')}</Text>
              </Flex>
            </Popover.Content>
          </Popover.Root>
        </Flex>}
      </>}
    </Flex>
  </Flex>;
}
