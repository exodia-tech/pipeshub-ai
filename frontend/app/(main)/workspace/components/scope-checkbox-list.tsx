'use client';

import { useId } from 'react';
import { Box, Checkbox, Flex, Text } from '@radix-ui/themes';

export interface ScopeOption { name: string; description: string; category: string }

export function ScopeCheckboxList<T extends ScopeOption>({ groups, selected, onScopeChange, onCategoryChange, disabled = false }: {
  groups: [string, T[]][];
  selected: Set<string>;
  onScopeChange: (name: string, checked: boolean) => void;
  onCategoryChange: (items: T[], checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return <Flex direction="column" gap="3">
    {groups.map(([category, items]) => {
      const count = items.filter((item) => selected.has(item.name)).length;
      return <Box key={category} style={{ backgroundColor: 'var(--olive-2)', border: '1px solid var(--olive-3)', borderRadius: 'var(--radius-2)', padding: 'var(--space-3)' }}>
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <Checkbox aria-label={category} checked={count === items.length ? true : count === 0 ? false : 'indeterminate'}
              disabled={disabled} onCheckedChange={(checked) => onCategoryChange(items, checked === true)} />
            <Text size="2" weight="medium">{category}</Text>
          </Flex>
          <Text size="2" color="gray">{count}/{items.length}</Text>
        </Flex>
        <Flex direction="column" gap="2" mt="3">
          {items.map((scope) => <Flex key={scope.name} align="start" gap="2" style={{ padding: 'var(--space-2)', borderRadius: 'var(--radius-2)', border: '1px solid var(--olive-4)' }}>
            <Checkbox id={`${id}-${scope.name}`} aria-label={scope.name} checked={selected.has(scope.name)} disabled={disabled}
              onCheckedChange={(checked) => onScopeChange(scope.name, checked === true)} style={{ marginTop: 2 }} />
            <Flex direction="column" gap="1" style={{ minWidth: 0 }}>
              <Text as="label" htmlFor={`${id}-${scope.name}`} size="2" weight="medium" style={{ fontFamily: 'var(--code-font-family)', overflowWrap: 'anywhere' }}>{scope.name}</Text>
              <Text size="2" color="gray">{scope.description}</Text>
            </Flex>
          </Flex>)}
        </Flex>
      </Box>;
    })}
  </Flex>;
}
