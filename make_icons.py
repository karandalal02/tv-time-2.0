#!/usr/bin/env python3
"""Generate app icons (PNG) using only the Python standard library.

Draws a full-bleed vertical gradient with a centered white 'play' triangle.
iOS rounds the corners of Home Screen icons automatically, so we keep the
background full-bleed (good for PWA 'maskable' icons too).
"""
import zlib
import struct
import os

OUT_DIR = os.path.join(os.path.dirname(__file__), "icons")

# Gradient endpoints (top -> bottom)
TOP = (124, 108, 240)      # #7C6CF0
BOTTOM = (75, 61, 200)      # #4B3DC8
GLYPH = (255, 255, 255)


def lerp(a, b, t):
    return int(a + (b - a) * t)


def in_play_triangle(x, y, size):
    """Point-in-triangle test for a right-pointing 'play' glyph, centered."""
    # Triangle bounding box ~ 42% of the icon, centered, nudged right a touch.
    s = size * 0.40
    cx, cy = size / 2 + size * 0.04, size / 2
    # Vertices: two on the left edge, one on the right (point).
    x1, y1 = cx - s * 0.55, cy - s * 0.62
    x2, y2 = cx - s * 0.55, cy + s * 0.62
    x3, y3 = cx + s * 0.72, cy

    def sign(ax, ay, bx, by, px, py):
        return (px - bx) * (ay - by) - (ax - bx) * (py - by)

    d1 = sign(x1, y1, x2, y2, x, y)
    d2 = sign(x2, y2, x3, y3, x, y)
    d3 = sign(x3, y3, x1, y1, x, y)
    has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (has_neg and has_pos)


def make_png(size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type 0 for each scanline
        t = y / (size - 1)
        bg = (lerp(TOP[0], BOTTOM[0], t),
              lerp(TOP[1], BOTTOM[1], t),
              lerp(TOP[2], BOTTOM[2], t))
        for x in range(size):
            if in_play_triangle(x, y, size):
                raw.extend(GLYPH)
            else:
                raw.extend(bg)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        c += struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    idat = zlib.compress(bytes(raw), 9)
    png = sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    return png


if __name__ == "__main__":
    for size in (180, 192, 512):
        path = os.path.join(OUT_DIR, f"icon-{size}.png")
        with open(path, "wb") as f:
            f.write(make_png(size))
        print("wrote", path)
