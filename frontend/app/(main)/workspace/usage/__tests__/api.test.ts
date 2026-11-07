import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageApi } from "../api";
import { apiClient } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  apiClient: { get: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

describe("usage API", () => {
  beforeEach(() => vi.clearAllMocks());
  it("does not send read-only metadata when editing a saved rate", async () => {
    const rates = {
      input: "1",
      output: "2",
      cache_read: "0.1",
      cache_write: "1.25",
    };
    await usageApi.saveRate({
      provider: "provider",
      model: "model/with/slash",
      rates,
      updated_at: "2026-11-07",
    });
    expect(apiClient.put).toHaveBeenCalledWith("/api/v1/usage/rates", {
      provider: "provider",
      model: "model/with/slash",
      rates,
    });
  });
  it("keeps model identifiers in JSON when resetting pricing", async () => {
    await usageApi.resetRate("provider", "model/with/slash");
    expect(apiClient.delete).toHaveBeenCalledWith("/api/v1/usage/rates", {
      data: { provider: "provider", model: "model/with/slash" },
    });
  });
});
