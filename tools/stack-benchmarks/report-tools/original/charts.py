#!/usr/bin/env python3
"""Render Supabase themed benchmark cards from benchmark-data.json."""
from __future__ import annotations

import html
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

OUT = Path(__file__).resolve().parents[2] / "report"
ASSETS = OUT / "assets"
W, H = 1600, 1000
BG, PAPER, MUTED, FAINT = "#0b0d0c", "#f4f7f4", "#9ca9a2", "#53615a"
GREEN, GREEN_SOFT, BASE, BASE_EDGE = "#3ecf8e", "#a8f5ce", "#47504b", "#65706a"


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def t(x: float, y: float, value: str, size: int, fill: str = PAPER, weight: str = "400", anchor: str = "start", letter: float = 0) -> str:
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="Arial,Arial Unicode MS,sans-serif" '
            f'font-size="{size}px" font-weight="{weight}" letter-spacing="{letter}px" fill="{fill}" text-anchor="{anchor}">{esc(value)}</text>')


def rect(x: float, y: float, w: float, h: float, fill: str, rx: float = 0, opacity: float = 1, stroke: str | None = None) -> str:
    border = f' stroke="{stroke}" stroke-width="1"' if stroke else ""
    return f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" rx="{rx:.1f}" fill="{fill}" opacity="{opacity:.2f}"{border}/>'


def line(x1: float, y1: float, x2: float, y2: float, stroke: str, width: float = 1, dash: str | None = None, opacity: float = 1) -> str:
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{stroke}" stroke-width="{width:.1f}" opacity="{opacity:.2f}"{d}/>'


def header(title: str, description: str) -> list[str]:
    return [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">', f'<title id="title">{esc(title)}</title>', f'<desc id="desc">{esc(description)}</desc>', '<defs><linearGradient id="greenBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b1f8d2"/><stop offset="0.48" stop-color="#3ecf8e"/><stop offset="1" stop-color="#269b6b"/></linearGradient><linearGradient id="baseBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#65716a"/><stop offset="1" stop-color="#303833"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="16" result="blur"/></filter></defs>', rect(0, 0, W, H, BG), '<circle cx="1430" cy="170" r="300" fill="#113e2c" opacity="0.16" filter="url(#glow)"/>']


def row(label: str, old: float, new: float, detail: str) -> dict[str, Any]:
    return {"label": label, "old": old, "new": new, "ratio": old / new, "detail": detail}


def draw_groups(parts: list[str], groups: list[dict[str, Any]], baseline: float = 1, chart_bottom: float = 790) -> None:
    left, right, ymax = 120, 1480, max([baseline, *(g["ratio"] for g in groups)])
    unit = 390 / ymax
    step = (right - left) / len(groups)
    baseline_h, base_y = baseline * unit, chart_bottom
    base_line_y = base_y - baseline_h
    parts.append(line(left - 20, base_line_y, right + 20, base_line_y, "#a0ada5", 1.5, "7 8", 0.55))
    parts.append(t(left - 20, base_line_y - 13, "1× baseline", 16, MUTED, "700", letter=1.2))
    for i, g in enumerate(groups):
        cx, bar_w, gap = left + step * (i + 0.5), 84, 18
        new_h = max(5, g["ratio"] * unit)
        bx, nx = cx - bar_w - gap / 2, cx + gap / 2
        parts.append(rect(bx, base_y - baseline_h, bar_w, baseline_h, BASE, 10, 1, BASE_EDGE))
        parts.append(rect(nx, base_y - new_h, bar_w, new_h, "url(#greenBar)", 10))
        parts.append(t(nx + bar_w / 2, base_y - new_h - 20, f'{g["ratio"]:.1f}×', 50, PAPER, "700", "middle"))
        parts.append(t(cx, 846, g["label"], 20, PAPER, "700", "middle"))
        parts.append(t(cx, 875, f'{g["old"]:.1f}s → {g["new"]:.1f}s', 17, MUTED, "500", "middle"))
        parts.append(t(cx, 901, g["detail"], 16, MUTED, "600", "middle", 0.3))


def write_chart(name: str, content: str) -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    svg, png = ASSETS / f"{name}.svg", ASSETS / f"{name}.png"
    svg.write_text(content)
    font_dir = next((Path(p) for p in (os.environ.get("BENCHMARK_FONT_DIR", ""), "/System/Library/Fonts/Supplemental", "/Library/Fonts") if p and Path(p).is_dir()), None)
    if font_dir is None:
        raise RuntimeError("Arial font directory is unavailable; set BENCHMARK_FONT_DIR")
    fonts = [str(font_dir / name) for name in ("Arial.ttf", "Arial Bold.ttf", "Arial Black.ttf", "Arial Unicode.ttf")]
    if not all(Path(font).exists() for font in fonts):
        raise RuntimeError("required Arial font files are unavailable")
    node = shutil.which("node") or raise_runtime("node is unavailable")
    modules = os.environ.get("RESVG_NODE_MODULES")
    package = Path(modules) / "@resvg" / "resvg-js" if modules else None
    if package is not None and not package.exists():
        package = None
    if package is None:
        raise RuntimeError("@resvg/resvg-js is unavailable; set RESVG_NODE_MODULES")
    js = "const fs=require('fs'); const {Resvg}=require(process.argv[3]); const svg=fs.readFileSync(process.argv[1], 'utf8'); const r=new Resvg(svg,{font:{fontFiles:process.argv.slice(4),loadSystemFonts:false,defaultFontFamily:'Arial'}}); fs.writeFileSync(process.argv[2],r.render().asPng());"
    subprocess.run([node, "-e", js, str(svg), str(png), str(package), *fonts], check=True)

def raise_runtime(message: str) -> str:
    raise RuntimeError(message)


def card(name: str, eyebrow: str, headline: str, subtitle: str, groups: list[dict[str, Any]], footer: list[str], description: str) -> None:
    parts = header(headline, description)
    parts += [t(92, 78, eyebrow, 17, GREEN, "700", letter=2.3), t(92, 180, headline, 92, PAPER, "900"), t(94, 232, subtitle, 22, MUTED, "500"), line(92, 280, 1508, 280, "#26322c", 1)]
    parts += [rect(1080, 232, 18, 18, BASE, 5), t(1112, 247, "CURRENT CLI", 13, MUTED, "700", letter=1), rect(1290, 232, 18, 18, GREEN, 5), t(1322, 247, "NEW STACK", 13, GREEN_SOFT, "700", letter=1)]
    draw_groups(parts, groups)
    parts.append(line(92, 930, 1508, 930, "#26322c", 1))
    for i, foot in enumerate(footer):
        parts.append(t(92, 961 + i * 19, foot, 16, PAPER if i == 0 else MUTED, "600" if i == 0 else "400", letter=0.15))
    parts += [t(1508, 961 + (len(footer) - 1) * 19, "supabase.com", 13, FAINT, "600", "end", 0.5), "</svg>"]
    write_chart(name, "".join(parts))
