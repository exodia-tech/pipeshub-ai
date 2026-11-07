import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import "@/lib/__tests__/test-i18n";
import { ChatCompanion } from "../chat-companion";
import { useChatStore } from '@/chat/store';

afterEach(() => {
  cleanup();
  useChatStore.setState({ slots: {}, activeSlotId: null, composerTypingSlotId: null });
  vi.useRealTimers();
});

describe("chat companion", () => {
  it('follows only the active conversation, prioritizes thinking, and settles on stop', () => {
    const store = useChatStore.getState();
    const first = store.createSlot(null);
    const second = store.createSlot(null);
    store.setActiveSlot(first);
    const { container } = render(<Theme><ChatCompanion followChat /><ChatCompanion /></Theme>);
    act(() => useChatStore.setState({ composerTypingSlotId: first }));
    expect(container.querySelectorAll('.chat-companion--typing').length).toBe(1);
    expect(container.querySelector('.chat-companion__eyes ellipse')?.getAttribute('cy')).toBe('38');
    act(() => store.updateSlot(first, { isStreaming: true }));
    expect(container.querySelector('.chat-companion--thinking')).toBeTruthy();
    expect(container.querySelector('.chat-companion--typing')).toBeNull();
    act(() => { store.updateSlot(first, { isStreaming: false }); useChatStore.setState({ composerTypingSlotId: null }); });
    expect(container.querySelector('.chat-companion--thinking')).toBeNull();
    act(() => store.updateSlot(first, { remoteRunInProgress: true }));
    expect(container.querySelector('.chat-companion--thinking')).toBeTruthy();
    act(() => store.setActiveSlot(second));
    expect(container.querySelector('.chat-companion--thinking')).toBeNull();
    act(() => store.updateSlot(second, { isStreaming: true, stopping: true }));
    expect(container.querySelector('.chat-companion--thinking')).toBeNull();
  });
  it("responds to a hello without submitting the surrounding composer", () => {
    vi.useFakeTimers();
    const submit = vi.fn();
    const { container } = render(
      <Theme>
        <form onSubmit={submit}>
          <ChatCompanion size={88} interactive />
        </form>
      </Theme>,
    );
    const button = screen.getByRole("button", { name: "Say hello" });
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(container.querySelector(".chat-companion--greeting")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("Hello!");
    expect(submit).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1200));
    expect(container.querySelector(".chat-companion--greeting")).toBeNull();
  });
  it("keeps small status faces decorative and exposes their loading text", () => {
    const { container } = render(
      <Theme>
        <ChatCompanion size={20} variant="thinking" showLabel />
      </Theme>,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("width")).toBe("20");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".chat-companion--thinking")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Loading");
  });
});
