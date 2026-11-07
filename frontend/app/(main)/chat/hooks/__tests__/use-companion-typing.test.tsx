import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/chat/store';
import { useCompanionTyping } from '../use-companion-typing';

afterEach(() => {
  cleanup();
  useChatStore.setState({ slots: {}, activeSlotId: null, composerTypingSlotId: null });
  vi.useRealTimers();
});

describe('companion typing', () => {
  it('reacts before a new chat has a conversation slot', () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useCompanionTyping(null, true, 'Hello'));
    act(() => result.current('Hello'));
    expect(useChatStore.getState().composerTypingSlotId).toBe('new-chat');
    act(() => result.current('   '));
    expect(useChatStore.getState().composerTypingSlotId).toBeNull();
    act(() => result.current('Hello'));
    unmount();
    expect(useChatStore.getState().composerTypingSlotId).toBeNull();
  });
  it('reacts to edits, settles after a pause, and clears on submit', () => {
    vi.useFakeTimers();
    const id = useChatStore.getState().createSlot(null);
    const { result, rerender } = renderHook(({ message }) => useCompanionTyping(id, true, message), { initialProps: { message: 'Ciao' } });
    act(() => result.current('Ciao'));
    expect(useChatStore.getState().composerTypingSlotId).toBe(id);
    act(() => vi.advanceTimersByTime(800));
    act(() => result.current('Ciao!'));
    act(() => vi.advanceTimersByTime(800));
    expect(useChatStore.getState().composerTypingSlotId).toBe(id);
    act(() => vi.advanceTimersByTime(100));
    expect(useChatStore.getState().composerTypingSlotId).toBeNull();
    act(() => result.current('Ciao!'));
    rerender({ message: '' });
    expect(useChatStore.getState().composerTypingSlotId).toBeNull();
  });

  it('cleans up on conversation switch/unmount and ignores embedded composers', () => {
    vi.useFakeTimers();
    const first = useChatStore.getState().createSlot(null);
    const second = useChatStore.getState().createSlot(null);
    const { result, rerender, unmount } = renderHook(({ id, enabled }) => useCompanionTyping(id, enabled, 'Hello'), { initialProps: { id: first, enabled: true } });
    act(() => result.current('Hello'));
    rerender({ id: second, enabled: true });
    expect(useChatStore.getState().composerTypingSlotId).toBeNull();
    act(() => result.current('Hello'));
    act(() => vi.advanceTimersByTime(899));
    expect(useChatStore.getState().composerTypingSlotId).toBe(second);
    rerender({ id: second, enabled: false });
    act(() => result.current('Widget text'));
    expect(useChatStore.getState().composerTypingSlotId).toBeNull();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
