#!/usr/bin/env python3
"""A picture of a terminal screen: the cells screen-render.mjs reports with JW_SCREEN_CELLS=1, drawn with their
colours and styles, so that a screen can be looked at rather than read as text.
Usage: python3 -I scripts/screen-png.py <cells json> <out.png> [dark|light]"""
import json, sys
from PIL import Image, ImageDraw, ImageFont

# The screen, the picture, and the theme.
cells = json.load(open(sys.argv[1], encoding="utf-8"))["cells"]
out, theme = sys.argv[2], (sys.argv[3] if len(sys.argv) > 3 else "dark")
# One cell's size in pixels; a wide character takes two cells.
CW, CH, SIZE = 10, 22, 17
FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"
# Index 2 of the collection is Noto Sans Mono CJK SC.
regular = ImageFont.truetype(FONT, SIZE, index=2)
bold = ImageFont.truetype(BOLD, SIZE, index=2)
# The terminal's default colours and its 16-colour palette (a common dark and light scheme).
DARK = {"fg": (220, 220, 220), "bg": (24, 24, 24)}
LIGHT = {"fg": (40, 40, 40), "bg": (252, 252, 252)}
base = DARK if theme == "dark" else LIGHT
PALETTE = [(0, 0, 0), (205, 49, 49), (13, 188, 121), (229, 229, 16), (36, 114, 200), (188, 63, 188), (17, 168, 205), (229, 229, 229),
           (102, 102, 102), (241, 76, 76), (35, 209, 139), (245, 245, 67), (59, 142, 234), (214, 112, 214), (41, 184, 219), (255, 255, 255)]


def colour(value, default):
    """A cell colour value as RGB."""
    if value < 0:
        return default
    if value >= 1 << 24:
        v = value - (1 << 24)
        return ((v >> 16) & 255, (v >> 8) & 255, v & 255)
    if value < 16:
        return PALETTE[value]
    if value < 232:
        v = value - 16
        steps = [0, 95, 135, 175, 215, 255]
        return (steps[v // 36], steps[(v // 6) % 6], steps[v % 6])
    g = 8 + (value - 232) * 10
    return (g, g, g)


rows, cols = len(cells), max((sum(c["w"] for c in row) for row in cells), default=80)
img = Image.new("RGB", (cols * CW, rows * CH), base["bg"])
draw = ImageDraw.Draw(img)
# Backgrounds first, then the text, so that no cell's background covers the edge of its neighbour's glyph.
placed = []
for y, row in enumerate(cells):
    x = 0
    for c in row:
        w = c["w"]
        # The second half of a wide character has width 0 and is already drawn.
        if w == 0:
            continue
        fg, bg = colour(c["fg"], base["fg"]), colour(c["bg"], base["bg"])
        if c["i"]:
            fg, bg = bg, fg
        if c["d"]:
            fg = tuple((f + b) // 2 for f, b in zip(fg, bg))
        draw.rectangle([x * CW, y * CH, (x + w) * CW - 1, (y + 1) * CH - 1], fill=bg)
        placed.append((x, y, w, c, fg))
        x += w
for x, y, w, c, fg in placed:
    if c["ch"].strip():
        draw.text((x * CW, y * CH + 1), c["ch"], fill=fg, font=bold if c["b"] else regular)
    if c["u"]:
        draw.line([x * CW, (y + 1) * CH - 2, (x + w) * CW - 1, (y + 1) * CH - 2], fill=fg)
img.save(out)
print(f"{out} {cols}x{rows} cells")
