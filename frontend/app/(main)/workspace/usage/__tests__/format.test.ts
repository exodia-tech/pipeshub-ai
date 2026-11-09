import { describe, expect, it } from "vitest";
import {
  chartMaximum,
  exclusiveEnd,
  metricValue,
  money,
  seriesSegments,
  timelineTicks,
} from "../format";
import type { Totals } from "../api";

describe("usage presentation", () => {
  it("aligns readable date ticks with actual buckets, including uneven ranges", () => {
    const labels = Array.from({ length: 8 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);
    const ticks = timelineTicks(labels, "day", "en-US", 5);
    expect(ticks.map((t) => t.index)).toEqual([0, 2, 4, 5, 7]);
    expect(ticks.map((t) => t.label)).toEqual(["Nov 1", "Nov 3", "Nov 5", "Nov 6", "Nov 8"]);
    expect(ticks[1].position).toBeCloseTo(2 / 7 * 100);
    expect(timelineTicks(labels, "day", "en-US", 3)).toHaveLength(3);
  });
  it("distinguishes UTC hours across midnight and handles short ranges", () => {
    expect(timelineTicks(["2026-11-08T23:00:00Z", "2026-11-09T00:00:00Z"], "hour", "en-US", 5).map((t) => t.label))
      .toEqual(["Nov 8, 23:00", "Nov 9, 00:00"]);
    expect(timelineTicks(["2026-11"], "month", "en-US", 5)[0]).toMatchObject({ position: 0, label: "Nov 2026" });
    expect(timelineTicks([], "day", "en-US", 5)).toEqual([]);
  });
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
    const partial = {
      ...row,
      requests: 2,
      unpriced_requests: 1,
      cost_usd: 0.0003,
    };
    expect(metricValue(partial, "cost")).toBe(0.0003);
    expect(chartMaximum([unknown, partial], "cost")).toBe(0.0003);
    expect(chartMaximum([], "cost")).toBe(0);
    expect(metricValue(unknown, "cost")).toBeNull();
    expect(metricValue(row, "cost")).toBe(0);
    expect(seriesSegments([row, unknown, row], "cost")).toEqual([
      [{ index: 0, value: 0 }],
      [{ index: 2, value: 0 }],
    ]);
  });
});
