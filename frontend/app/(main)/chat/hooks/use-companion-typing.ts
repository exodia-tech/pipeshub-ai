'use client';

import { useCallback, useEffect, useRef } from 'react';
import { useChatStore } from '@/chat/store';

export function useCompanionTyping(slotId: string | null, enabled: boolean, message: string) {
  // The landing page has no conversation slot until its first message is sent.
  const context = slotId ?? 'new-chat';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useCallback(() => {
    clearTimeout(timer.current);
    if (enabled && useChatStore.getState().composerTypingSlotId === context) {
      useChatStore.setState({ composerTypingSlotId: null });
    }
  }, [context, enabled]);

  useEffect(() => clear, [clear]);
  useEffect(() => {
    if (!message) clear();
  }, [message, clear]);

  return useCallback((text: string) => {
    clearTimeout(timer.current);
    if (!enabled) return;
    if (!text.trim()) {
      clear();
      return;
    }
    if (useChatStore.getState().composerTypingSlotId !== context) {
      useChatStore.setState({ composerTypingSlotId: context });
    }
    timer.current = setTimeout(clear, 900);
  }, [context, enabled, clear]);
}
