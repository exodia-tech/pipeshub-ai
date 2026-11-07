import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import en from "@/lib/i18n/locales/en-US.json";
import itLocale from "@/lib/i18n/locales/it-IT.json";
import { WelcomeGreeting, localDaypart } from "../welcome-greeting";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
async function show(name?: string, language = "en-US") {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    resources: {
      "en-US": { translation: en },
      "it-IT": { translation: itLocale },
    },
    interpolation: { escapeValue: false },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <WelcomeGreeting name={name} />
    </I18nextProvider>,
  );
}
describe("local-time welcome", () => {
  it.each([
    [0, "night"],
    [4, "night"],
    [5, "morning"],
    [11, "morning"],
    [12, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [21, "evening"],
    [22, "night"],
    [23, "night"],
  ])("maps local hour %s to %s", (hour, part) => {
    expect(localDaypart(Number(hour))).toBe(part);
  });
  it("crosses a time boundary while open and refreshes after returning to the tab", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 11, 59, 30));
    await show("Sofia");
    expect(screen.getByText("Good morning, Sofia")).toBeTruthy();
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByText("Good afternoon, Sofia")).toBeTruthy();
    vi.setSystemTime(new Date(2026, 0, 1, 22));
    fireEvent.focus(window);
    expect(screen.getByText("Good night, Sofia")).toBeTruthy();
  });
  it("uses a natural unnamed greeting and Italian copy", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 8));
    await show(undefined, "it-IT");
    expect(screen.getByText("Buongiorno")).toBeTruthy();
    cleanup();
    await show("Sofia", "it-IT");
    expect(screen.getByText("Buongiorno, Sofia")).toBeTruthy();
  });
});
