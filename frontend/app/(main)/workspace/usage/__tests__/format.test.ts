import { describe, expect, it } from "vitest";
import {
  chartMaximum,
  exclusiveEnd,
  metricValue,
  money,
  seriesSegments,
} from "../format";
import type { Totals } from "../api";

describe("usage presentation", () => {
  it("uses an exclusive UTC end across month and daylight-saving boundaries", () => {
    expect(exclusiveEnd("2026-10-31")).toBe("2026-11-01T00:00:00.000Z");
    expect(exclusiveEnd("2026-03-29")).toBe("2026-03-30T00:00:00.000Z");
  });
  it("keeps unknown cost distinct from free usage and displays sub-cent costs", () => {
    expect(money(null, "en-US")).toBe("—");
    expect(money(0, "en-US")).toBe("$0.00");
    expect(money(0.000469, "en-US")).toBe("$0.000469");
    expect(money(0.000000001, "en-US")).toBe("$0.000000001");
  });
  it("does not add cache or reasoning tokens to the provider totals again", () => {
    const row: Totals = {
      requests: 2,
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 20,
      cache_write_tokens: 10,
      reasoning_tokens: 25,
      cost_usd: 0.000469,
      unpriced_requests: 0,
      estimated_requests: 0,
      unknown_requests: 0,
      incomplete_requests: 0,
      average_duration_ms: 100,
      units: 2,
    };
    expect(metricValue(row, "tokens")).toBe(150);
    expect(metricValue(row, "cost")).toBe(0.000469);
    expect(chartMaximum([row], "cost")).toBe(0.000469);
  });
  it("keeps unpriced chart values unknown and leaves gaps in the timeline", () => {
    const row = {
      requests: 1,
      unpriced_requests: 0,
      unknown_requests: 0,
      cost_usd: 0,
    } as Totals;
    const unknown = { ...row, unpriced_requests: 1 };
    expect(metricValue(unknown, "cost")).toBeNull();
    expect(metricValue(row, "cost")).toBe(0);
    expect(seriesSegments([row, unknown, row], "cost")).toEqual([
      [{ index: 0, value: 0 }],
      [{ index: 2, value: 0 }],
    ]);
  });
});
