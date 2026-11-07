"use client";

import { useEffect, useState } from "react";

/** Reduce photos in stages so fine detail does not alias into hard pixels at avatar sizes. */
export function avatarThumbnail(
  image: HTMLImageElement,
  size: number,
  density: number,
): string {
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const target = Math.max(
    1,
    Math.min(side, Math.round(size * Math.min(3, Math.max(1, density)))),
  );
  let pixels = Math.max(target, Math.min(1024, Math.ceil(side / 2)));
  let source: CanvasImageSource = image;
  let first = true;
  while (true) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = pixels;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    if (first) {
      context.drawImage(
        image,
        (image.naturalWidth - side) / 2,
        (image.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        pixels,
        pixels,
      );
    } else {
      context.drawImage(source, 0, 0, pixels, pixels);
    }
    if (pixels === target) return canvas.toDataURL("image/png");
    source = canvas;
    first = false;
    pixels = Math.max(target, Math.ceil(pixels / 2));
  }
}

export function useAvatarImage(
  src: string | null | undefined,
  size: number,
): string | undefined {
  const [density, setDensity] = useState(1);
  useEffect(() => {
    const update = () => setDensity(window.devicePixelRatio || 1);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const [thumbnail, setThumbnail] = useState<{
    src: string;
    size: number;
    density: number;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (cancelled) return;
      try {
        const url = avatarThumbnail(image, size, density);
        if (!cancelled) setThumbnail({ src, size, density, url });
      } catch {
        // Remote images without canvas access keep their original browser rendering.
      }
    };
    image.src = src;
    return () => {
      cancelled = true;
      image.onload = null;
    };
  }, [src, size, density]);
  return thumbnail &&
    thumbnail.src === src &&
    thumbnail.size === size &&
    thumbnail.density === density
    ? thumbnail.url
    : src || undefined;
}
