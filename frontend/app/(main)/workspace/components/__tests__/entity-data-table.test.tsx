import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Theme } from "@radix-ui/themes";
import { EntityDataTable } from "../entity-data-table";

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

for (const mobile of [false, true]) {
  describe(mobile ? "mobile entity list" : "desktop entity table", () => {
    const show = (select?: (ids: Set<string>) => void) => {
      vi.stubGlobal("matchMedia", () => ({ matches: mobile, addEventListener() {}, removeEventListener() {} }));
      return render(<Theme><EntityDataTable data={[{ id: "alice", name: "Alice" }]}
        columns={[{ key: "name", label: "Name", render: (item) => item.name }]}
        getItemId={(item) => item.id} selectedIds={new Set()} onSelectionChange={select} /></Theme>);
    };
    it("keeps existing member selection working", () => {
      const select = vi.fn(); show(select);
      fireEvent.click(screen.getAllByRole("checkbox")[0]);
      expect(select).toHaveBeenCalledWith(new Set(["alice"]));
    });
    it("renders read-only records without empty selection controls", () => {
      show();
      expect(screen.getByText("Alice")).toBeTruthy();
      expect(screen.queryByRole("checkbox")).toBeNull();
    });
  });
}
