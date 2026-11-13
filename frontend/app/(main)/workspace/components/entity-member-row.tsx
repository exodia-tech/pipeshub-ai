'use client';

import type { ReactNode } from 'react';
import { Box, Flex } from '@radix-ui/themes';
import { AvatarCell, type AvatarCellProps } from './avatar-cell';

export function EntityMemberRow({ pendingRemoval = false, children, ...avatar }: AvatarCellProps & {
  pendingRemoval?: boolean;
  children?: ReactNode;
}) {
  return (
    <Flex align="center" justify="between" gap="2"
      style={{ opacity: pendingRemoval ? 0.5 : 1, transition: 'opacity 0.15s ease' }}>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <AvatarCell {...avatar} avatarSize={28} />
      </Box>
      <Flex align="center" gap="2" style={{ flexShrink: 0 }}>{children}</Flex>
    </Flex>
  );
}
