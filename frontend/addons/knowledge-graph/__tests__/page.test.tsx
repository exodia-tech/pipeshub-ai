import '@/lib/__tests__/test-i18n';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import { clusterLayout } from '../cluster-layout';
import type { GraphData } from '../api';
import { clearSessionCache } from '@/lib/api/session-cache';

const api = vi.hoisted(() => ({ loadGraph: vi.fn(), cluster: vi.fn(), node: vi.fn(), reset: vi.fn() }));
vi.mock('../api', () => ({ loadGraph: api.loadGraph }));
vi.mock('../graph-canvas', () => ({ GraphCanvas: React.forwardRef(function Canvas({ label, onReady }: { label: string; onReady(): void }, ref) {
  React.useImperativeHandle(ref, () => ({ cluster: api.cluster, node: api.node, reset: api.reset, zoom: vi.fn() }));
  React.useEffect(() => { onReady(); }, []);
  return <div role="img" aria-label={label} />;
}) }));
import KnowledgeGraphPage from '../index';

beforeEach(() => {
  vi.stubGlobal('Worker', class {
    onmessage?: (e: { data: unknown }) => void;
    postMessage(data: GraphData) { queueMicrotask(() => this.onmessage?.({ data: { result: clusterLayout(data) } })); }
    terminate() {}
  });
});
afterEach(() => { cleanup(); clearSessionCache(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('Cluster overview', () => {
  it('loads without search, zooms into a cluster and finds/opens a record', async () => {
    api.loadGraph.mockResolvedValue({ nodes: [{ id: 'record:a', name: 'Pricing guide', kind: 'record', recordId: 'a' }, { id: 'topic', name: 'Sales', kind: 'topic' }], edges: [{ source: 'record:a', target: 'topic' }] });
    render(<Theme><KnowledgeGraphPage /></Theme>);
    const cluster = await screen.findByRole('button', { name: /Sales/ });
    fireEvent.click(cluster);
    expect(api.cluster).toHaveBeenCalledWith(0);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pricing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pricing guide' }));
    expect(api.node).toHaveBeenCalledWith('record:a');
    expect(screen.getByRole('link', { name: 'Open record' }).getAttribute('href')).toBe('/record/?recordId=a');
    fireEvent.click(screen.getByRole('button', { name: 'Show whole graph' }));
    expect(api.reset).toHaveBeenCalled();
  });
  it('shows a retryable error without claiming an empty graph', async () => {
    api.loadGraph.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ nodes: [], edges: [] });
    render(<Theme><KnowledgeGraphPage /></Theme>);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('No knowledge is visible to your account yet.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No knowledge is visible to your account yet.')).toBeTruthy();
  });
});
