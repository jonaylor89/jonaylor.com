#!/usr/bin/env python3
"""Overlay a safe-area DEV badge on the original launcher art. Requires Pillow.

Generated resources are committed; normal Gradle builds do not need Python/Pillow.
Both legacy icons and the adaptive foreground are covered, at every source density.
The lettering is drawn as paths so generation does not depend on installed fonts.
"""

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "app/src/main/res"
DESTINATION = ROOT / "app/src/dev/res"
CORAL = "#FFB09A"
INK = "#153743"


def badged(source: Path) -> Image.Image:
    image = Image.open(source).convert("RGBA")
    size = image.width
    # Supersample the badge, preserving the original art rather than resampling it.
    overlay = Image.new("RGBA", (size * 4, size * 4))
    draw = ImageDraw.Draw(overlay)
    adaptive = source.stem == "ic_launcher_foreground"
    # Adaptive badge remains inside Android's central 66/108 safe area.
    bounds = (34, 66, 74, 80) if adaptive else (25, 71, 75, 87)
    viewport = 108 if adaptive else 100
    scale = size * 4 / viewport
    x1, y1, x2, y2 = (v * scale for v in bounds)
    draw.rounded_rectangle((x1, y1, x2, y2), radius=4 * scale, fill=CORAL,
                           outline=INK, width=max(1, round(scale)))
    letter_scale = (y2 - y1) * 0.57 / 8
    x = (x1 + x2 - 21 * letter_scale) / 2
    y = (y1 + y2 - 8 * letter_scale) / 2
    strokes = [
        [(0, 0), (3, 0), (5, 2), (5, 6), (3, 8), (0, 8), (0, 0)],
        [(13, 0), (8, 0), (8, 8), (13, 8)],
        [(8, 4), (12, 4)],
        [(16, 0), (18.5, 8), (21, 0)],
    ]
    for stroke in strokes:
        draw.line([(x + a * letter_scale, y + b * letter_scale) for a, b in stroke],
                  fill=INK, width=max(1, round(1.5 * letter_scale)), joint="curve")
    return Image.alpha_composite(image, overlay.resize(image.size, Image.Resampling.LANCZOS))


if __name__ == "__main__":
    for source in sorted(SOURCE.glob("mipmap-*/*.png")):
        destination = DESTINATION / source.relative_to(SOURCE)
        destination.parent.mkdir(parents=True, exist_ok=True)
        badged(source).save(destination, optimize=True)
        print(destination.relative_to(ROOT))
