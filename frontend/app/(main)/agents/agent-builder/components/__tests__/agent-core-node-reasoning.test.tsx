import '@/lib/__tests__/test-i18n';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Theme } from '@radix-ui/themes';
import type { FlowNodeData } from '../../types';

const flow = vi.hoisted(() => ({
  nodes: [] as { id: string; data: unknown }[],
  setNodes: vi.fn(),
  edges: [] as { source: string; target: string; targetHandle?: string }[],
}));

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  useReactFlow: () => ({ setNodes: flow.setNodes }),
  useStore: (selector: (s: typeof flow) => unknown) => selector(flow),
  useNodeConnections: () => [],
}));

vi.mock('@/app/components/ui', () => ({
  ConnectorIcon: () => null,
}));

vi.mock('@/app/components/ui/themeable-asset-icon', () => ({
  ThemeableAssetIcon: () => null,
  themeableAssetIconPresets: { flowNodeHeader: {}, flowNodeWell: {} },
}));

import { AgentCoreNode } from '../agent-core-node';

const AGENT: FlowNodeData = {
  id: 'agent-core',
  type: 'agent-core',
  label: 'Agent',
  description: '',
  icon: 'smart_toy',
  category: 'agent',
  config: {},
  inputs: [],
  outputs: [],
  isConfigured: true,
};

import { extractAgentConfigFromFlow } from '../../extract-agent-config';

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

describe('agent default reasoning with the organization model', () => {
  it.each([['Low', 'low'], ['Inherit model default', null]])('saves %s without a model node', async (label, expected) => {
    flow.setNodes.mockReset();
    const agent = { ...AGENT, config: { systemPrompt: 'Keep this prompt', defaultReasoningEffort: 'high' } };
    render(<Theme><AgentCoreNode data={agent} selected={false} /></Theme>);
    fireEvent.click(screen.getByRole('combobox', { name: 'Default reasoning effort' }));
    fireEvent.click(await screen.findByRole('option', { name: label, exact: true }));
    await waitFor(() => expect(flow.setNodes).toHaveBeenCalled());
    const updated = flow.setNodes.mock.calls[0][0]([{ id: agent.id, data: agent }]);
    const saved = extractAgentConfigFromFlow('Example agent', updated, []);
    expect(saved.defaultReasoningEffort).toBe(expected);
    expect(saved.systemPrompt).toBe('Keep this prompt');
    expect(saved.models).toEqual([]);
  });
});


