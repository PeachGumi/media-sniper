#!/usr/bin/env python3
"""Generate Media Sniper icons (crosshair + play triangle) with PIL."""
from PIL import Image, ImageDraw

ORANGE = (255, 122, 69, 255)
DARK = (23, 24, 28, 255)
LIGHT = (232, 232, 234, 255)


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = max(1, size // 16)
    # rounded dark background
    r = size // 5
    d.rounded_rectangle([pad, pad, size - pad, size - pad], radius=r, fill=DARK)
    cx = cy = size / 2
    # crosshair ring
    ring_w = max(2, size // 24)
    outer = size * 0.36
    d.ellipse([cx - outer, cy - outer, cx + outer, cy + outer], outline=ORANGE, width=ring_w)
    # crosshair ticks
    t = size * 0.36
    g = size * 0.10
    lw = max(2, size // 28)
    for (x0, y0, x1, y1) in [
        (cx, cy - t - g, cx, cy - t + g),
        (cx, cy + t - g, cx, cy + t + g),
        (cx - t - g, cy, cx - t + g, cy),
        (cx + t - g, cy, cx + t + g, cy),
    ]:
        d.line([x0, y0, x1, y1], fill=ORANGE, width=lw)
    # play triangle
    pr = size * 0.17
    p0 = (cx - pr * 0.55, cy - pr)
    p1 = (cx - pr * 0.55, cy + pr)
    p2 = (cx + pr * 1.1, cy)
    d.polygon([p0, p1, p2], fill=LIGHT)
    return img


def main() -> None:
    for s in (16, 32, 48, 128):
        make(s).save(f"icons/icon{s}.png")
        print(f"icons/icon{s}.png")


if __name__ == "__main__":
    main()
