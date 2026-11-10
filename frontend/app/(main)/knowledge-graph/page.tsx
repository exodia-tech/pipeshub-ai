'use client';

import { useRef, useState } from 'react';
import { Box, Button, Flex, Heading, Text, TextField } from '@radix-ui/themes';
import { Background, Controls, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useTranslation } from 'react-i18next';
import { useThemeAppearance } from '@/app/components/theme-provider';
import { MOBILE_HAMBURGER_GUTTER_PX } from '@/app/components/sidebar/constants';
import { useIsMobile } from '@/lib/hooks/use-is-mobile';
import { GraphApi, type Entity, type GraphRecord, type Neighborhood } from './api';

type GraphSelection = { kind: 'entity'; value: Entity } | { kind: 'record'; value: GraphRecord };

function safeSourceUrl(value?: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export default function KnowledgeGraphPage() {
  const { t } = useTranslation();
  const { appearance } = useThemeAppearance();
  const isMobile = useIsMobile();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Entity[]>([]);
  const [searched, setSearched] = useState(false);
  const [center, setCenter] = useState<Entity | null>(null);
  const [neighborhood, setNeighborhood] = useState<Neighborhood | null>(null);
  const [selection, setSelection] = useState<GraphSelection | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef(0);

  async function search() {
    if (!query.trim()) return;
    const id = ++request.current;
    setLoading(true); setError(false); setSearched(true);
    setResults([]); setCenter(null); setNeighborhood(null); setSelection(null);
    try {
      const found = await GraphApi.search(query.trim());
      if (id === request.current) setResults(found);
    } catch { if (id === request.current) setError(true); }
    finally { if (id === request.current) setLoading(false); }
  }

  async function explore(entity: Entity) {
    const id = ++request.current;
    setLoading(true); setError(false); setCenter(entity); setNeighborhood(null);
    setSelection({ kind: 'entity', value: entity });
    try {
      const data = await GraphApi.neighbors(entity);
      if (id === request.current) setNeighborhood(data);
    } catch { if (id === request.current) setError(true); }
    finally { if (id === request.current) setLoading(false); }
  }

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const targets = new Map<string, GraphSelection>();
  const nodeStyle = { border: '1px solid var(--agent-flow-well-border)', borderRadius: 14, background: 'var(--agent-flow-well-bg)', color: 'var(--agent-flow-text)', padding: '10px 12px', width: 170, fontSize: 15, boxShadow: '0 2px 8px #0002' };
  if (center && neighborhood) {
    nodes.push({ id: 'center', position: isMobile ? { x: 95, y: 0 } : { x: 230, y: 200 }, data: { label: center.name }, style: { ...nodeStyle, border: '2px solid var(--accent-9)', fontWeight: 600 } });
    const entries: GraphSelection[] = [
      ...neighborhood.records.map(value => ({ kind: 'record' as const, value })),
      ...neighborhood.relatedEntities.map(value => ({ kind: 'entity' as const, value })),
    ];
    entries.forEach((item, index) => {
      const id = `item-${index}`;
      const name = item.kind === 'record' ? item.value.recordName || item.value.recordId : item.value.name;
      targets.set(id, item);
      const row = item.kind === 'record' ? index : index - neighborhood.records.length;
      nodes.push({ id, position: isMobile ? { x: item.kind === 'record' ? 0 : 190, y: 90 + row * 72 } : { x: item.kind === 'record' ? 0 : 460, y: 30 + row * 72 }, data: { label: name }, style: { ...nodeStyle, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderColor: item.kind === 'record' ? 'var(--blue-8)' : 'var(--violet-8)' } });
      const label = row === 0 ? (item.kind === 'entity' ? t('graph.viaRecords') : t('graph.recordLink')) : undefined;
      edges.push({ id: `edge-${index}`, source: 'center', target: id, type: 'straight', style: { stroke: 'var(--gray-8)' }, label: isMobile ? undefined : label, labelStyle: { fill: 'var(--agent-flow-text-muted)', fontSize: 11 }, labelBgStyle: { fill: 'var(--color-panel-solid)' } });
    });
  }
  const source = selection?.kind === 'record' ? safeSourceUrl(selection.value.webUrl) : null;

  return <Flex direction="column" gap="4" p={{ initial: '4', md: '6' }} style={{ height: '100%', overflow: 'auto', minWidth: 0 }}>
    <Box><Heading size="6" style={{ paddingLeft: isMobile ? MOBILE_HAMBURGER_GUTTER_PX : 0 }}>{t('graph.title')}</Heading><Text as="p" size="2" color="gray" mt="2">{t('graph.intro')}</Text></Box>
    <form onSubmit={event => { event.preventDefault(); void search(); }}>
      <Flex gap="2" wrap="wrap"><Box style={{ flex: '1 1 220px' }}><TextField.Root size="3" value={query} onChange={event => setQuery(event.target.value)} placeholder={t('graph.placeholder')} aria-label={t('graph.placeholder')} /></Box><Button size="3" type="submit" disabled={loading || !query.trim()}>{t('graph.search')}</Button></Flex>
    </form>
    {loading && <Text role="status">{t('graph.loading')}</Text>}
    {error && <Text role="alert" color="red">{t('graph.error')}</Text>}
    {!loading && !error && searched && !results.length && !center && <Text color="gray">{t('graph.noResults')}</Text>}
    {!center && results.length > 0 && <Flex direction="column" gap="2"><Text weight="medium">{t('graph.select')}</Text>{results.map(item => <Button key={`${item.entityType}:${item.entityId}`} variant="soft" color="gray" onClick={() => void explore(item)} style={{ justifyContent: 'space-between', minHeight: 44, height: 'auto', textAlign: 'left' }}><span>{item.name}</span><Text size="1">{item.entityType.replaceAll('_', ' ')}</Text></Button>)}</Flex>}
    {center && <>
      <Flex align="center" justify="between" gap="3" wrap="wrap"><Text weight="medium">{center.name}</Text><Button variant="soft" color="gray" onClick={() => { ++request.current; setCenter(null); setNeighborhood(null); setSelection(null); setLoading(false); setError(false); }}>{t('graph.back')}</Button></Flex>
      {neighborhood && <>
        <Text size="2" color="gray">{t('graph.explanation')} {t('graph.scope')}</Text>
        <Flex gap="4" wrap="wrap"><Text size="2"><span style={{ color: 'var(--blue-9)' }}>●</span> {t('graph.records')}</Text><Text size="2"><span style={{ color: 'var(--violet-9)' }}>●</span> {t('graph.related')}</Text></Flex>
        {selection?.kind === 'record' && <Flex direction="column" gap="2"><Text weight="medium">{selection.value.recordName || selection.value.recordId}</Text><Text size="2" color="gray">{[selection.value.recordType, selection.value.app].filter(Boolean).join(' · ')}</Text><a href={`/record/?recordId=${encodeURIComponent(selection.value.recordId)}`}>{t('graph.openRecord')}</a>{source && <a href={source} target="_blank" rel="noopener noreferrer">{t('graph.openSource')}</a>}</Flex>}
        {selection?.kind === 'entity' && selection.value.entityId !== center.entityId && <Flex gap="3" align="center" wrap="wrap"><Text>{selection.value.name}</Text><Button size="3" variant="soft" onClick={() => void explore(selection.value as Entity)}>{t('graph.explore')}</Button></Flex>}
        <Box className="knowledge-graph-canvas" style={{ height: 480, minHeight: 320, flexShrink: 0, border: '1px solid var(--gray-6)', borderRadius: 16, overflow: 'hidden', background: 'var(--gray-2)' }}>
          <ReactFlow key={`${center.entityType}:${center.entityId}:${isMobile}`} colorMode={appearance} nodes={nodes} edges={edges} fitView fitViewOptions={{ padding: 0.15, minZoom: 0.7, maxZoom: 1 }} minZoom={0.7} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} onNodeClick={(_, node) => { const item = targets.get(node.id); if (item) setSelection(item); }}><Background color="var(--gray-6)" gap={24} /><Controls position={isMobile ? 'bottom-right' : 'bottom-left'} showInteractive={false} /></ReactFlow>
        </Box>
        {(neighborhood.nextCursor || neighborhood.note) && <Text size="1" color="gray">{t('graph.sample')}</Text>}
        <Flex direction="column" gap="2"><Text weight="medium">{t('graph.records')}</Text>{neighborhood.records.map(record => <Button key={record.recordId} variant="ghost" color="gray" onClick={() => setSelection({ kind: 'record', value: record })} style={{ justifyContent: 'start', minHeight: 44, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }}>{record.recordName || record.recordId}</Button>)}{!neighborhood.records.length && <Text color="gray">{t('graph.noRecords')}</Text>}</Flex>
        {neighborhood.relatedEntities.length > 0 && <Flex direction="column" gap="2"><Text weight="medium">{t('graph.related')}</Text>{neighborhood.relatedEntities.map(entity => <Button key={`${entity.entityType}:${entity.entityId}`} variant="ghost" color="gray" onClick={() => void explore(entity)} style={{ justifyContent: 'start', minHeight: 44, height: 'auto', whiteSpace: 'normal', textAlign: 'left' }}>{entity.name}</Button>)}</Flex>}
      </>}
    </>}
  </Flex>;
}
