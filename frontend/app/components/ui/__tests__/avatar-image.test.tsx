import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { avatarThumbnail, useAvatarImage } from "../avatar-image";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function canvasMocks() {
  const contexts: {
    imageSmoothingEnabled: boolean;
    imageSmoothingQuality: string;
    drawImage: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
    const context = {
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
      drawImage: vi.fn(),
    };
    contexts.push(context);
    return context as unknown as CanvasRenderingContext2D;
  });
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(
    function (this: HTMLCanvasElement) {
      return `data:thumbnail:${this.width}`;
    },
  );
  return contexts;
}

describe("avatar photo sampling", () => {
  it("crops once and reduces progressively with high-quality smoothing at the rendered density", () => {
    const contexts = canvasMocks();
    const image = { naturalWidth: 596, naturalHeight: 632 } as HTMLImageElement;
    expect(avatarThumbnail(image, 32, 1)).toBe("data:thumbnail:32");
    expect(contexts.map((c) => c.drawImage.mock.calls[0].at(-1))).toEqual([
      298, 149, 75, 38, 32,
    ]);
    expect(contexts[0].drawImage.mock.calls[0].slice(1, 5)).toEqual([
      0, 18, 596, 596,
    ]);
    expect(
      contexts.every(
        (c) => c.imageSmoothingEnabled && c.imageSmoothingQuality === "high",
      ),
    ).toBe(true);
    expect(avatarThumbnail(image, 32, 2)).toBe("data:thumbnail:64");
    expect(avatarThumbnail(image, 32, 4)).toBe("data:thumbnail:96");
    expect(
      avatarThumbnail(
        { naturalWidth: 16, naturalHeight: 20 } as HTMLImageElement,
        32,
        2,
      ),
    ).toBe("data:thumbnail:16");
  });

  it("does not replace a new member's photo with a late thumbnail from the previous source", () => {
    canvasMocks();
    const images: {
      onload: (() => void) | null;
      src: string;
      naturalWidth: number;
      naturalHeight: number;
    }[] = [];
    vi.stubGlobal(
      "Image",
      class {
        onload = null;
        src = "";
        naturalWidth = 100;
        naturalHeight = 100;
        constructor() {
          images.push(this);
        }
      },
    );
    const { result, rerender } = renderHook(
      ({ src }) => useAvatarImage(src, 32),
      { initialProps: { src: "first" } },
    );
    const oldLoad = images[0].onload!;
    rerender({ src: "second" });
    act(() => oldLoad());
    expect(result.current).toBe("second");
    act(() => images.at(-1)!.onload!());
    expect(result.current).toBe("data:thumbnail:32");
  });

  it("keeps the original when canvas rendering is unavailable", () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const images: { onload: (() => void) | null }[] = [];
    vi.stubGlobal(
      "Image",
      class {
        onload = null;
        src = "";
        naturalWidth = 100;
        naturalHeight = 100;
        constructor() {
          images.push(this);
        }
      },
    );
    const { result } = renderHook(() => useAvatarImage("original", 32));
    act(() => images.at(-1)!.onload!());
    expect(result.current).toBe("original");
  });
});
