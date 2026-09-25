#!/usr/bin/env python3
"""Render deterministic CLI benchmark charts from the collected report data."""
from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

W, H = 1600, 1000
BG, PAPER, MUTED, FAINT = "#0b0d0c", "#f4f7f4", "#9ca9a2", "#53615a"
GREEN, GREEN_SOFT, BASE, BASE_EDGE = "#3ecf8e", "#a8f5ce", "#47504b", "#65706a"


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def text(x: float, y: float, value: str, size: int, fill: str = PAPER,
         weight: str = "400", anchor: str = "start", letter: float = 0) -> str:
    return (f'<text x="{x:.1f}" y="{y:.1f}" font-family="Arial,Arial Unicode MS,sans-serif" '
            f'font-size="{size}px" font-weight="{weight}" letter-spacing="{letter}px" '
            f'fill="{fill}" text-anchor="{anchor}">{esc(value)}</text>')


def rect(x: float, y: float, w: float, h: float, fill: str, rx: float = 0,
         opacity: float = 1, stroke: str | None = None) -> str:
    border = f' stroke="{stroke}" stroke-width="1"' if stroke else ""
    return (f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" height="{h:.1f}" '
            f'rx="{rx:.1f}" fill="{fill}" opacity="{opacity:.2f}"{border}/>')


def line(x1: float, y1: float, x2: float, y2: float, stroke: str,
         width: float = 1, dash: str | None = None, opacity: float = 1) -> str:
    dashed = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" '
            f'stroke="{stroke}" stroke-width="{width:.1f}" opacity="{opacity:.2f}"{dashed}/>')


def start_svg(title: str, description: str) -> list[str]:
    return [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" role="img" aria-labelledby="title desc">',
        f'<title id="title">{esc(title)}</title>', f'<desc id="desc">{esc(description)}</desc>',
        '<defs><linearGradient id="greenBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b1f8d2"/><stop offset="0.48" stop-color="#3ecf8e"/><stop offset="1" stop-color="#269b6b"/></linearGradient><linearGradient id="baseBar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#65716a"/><stop offset="1" stop-color="#303833"/></linearGradient><filter id="glow"><feGaussianBlur stdDeviation="16" result="blur"/></filter></defs>',
        rect(0, 0, W, H, BG), '<circle cx="1430" cy="170" r="300" fill="#113e2c" opacity="0.16" filter="url(#glow)"/>',
    ]


def write_chart(out: Path, name: str, parts: list[str]) -> None:
    out.mkdir(parents=True, exist_ok=True)
    svg, png = out / f"{name}.svg", out / f"{name}.png"
    svg.write_text("".join([*parts, "</svg>"]), encoding="utf-8")
    font_dir = next((Path(p) for p in (os.environ.get("BENCHMARK_FONT_DIR", ""),
                     "/System/Library/Fonts/Supplemental", "/Library/Fonts")
                     if p and Path(p).is_dir()), None)
    if font_dir is None:
        raise RuntimeError("Arial font directory unavailable; set BENCHMARK_FONT_DIR")
    fonts = [str(font_dir / f) for f in ("Arial.ttf", "Arial Bold.ttf", "Arial Black.ttf", "Arial Unicode.ttf")]
    if not all(Path(font).exists() for font in fonts):
        raise RuntimeError("required Arial font files unavailable")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is unavailable")
    modules = os.environ.get("RESVG_NODE_MODULES")
    package = Path(modules) / "@resvg" / "resvg-js" if modules else None
    if not package or not package.exists():
        raise RuntimeError("@resvg/resvg-js unavailable; set RESVG_NODE_MODULES")
    js = "const fs=require('fs');const {Resvg}=require(process.argv[3]);const svg=fs.readFileSync(process.argv[1],'utf8');const r=new Resvg(svg,{font:{fontFiles:process.argv.slice(4),loadSystemFonts:false,defaultFontFamily:'Arial'}});fs.writeFileSync(process.argv[2],r.render().asPng());"
    subprocess.run([node, "-e", js, str(svg), str(png), str(package), *fonts], check=True)


def card_base(eyebrow: str, headline: str, subtitle: str, description: str) -> list[str]:
    p = start_svg(headline, description)
    p += [text(92, 78, eyebrow, 17, GREEN, "700", letter=2.3),
          text(92, 177, headline, 78, PAPER, "900"), text(94, 228, subtitle, 21, MUTED),
          line(92, 280, 1508, 280, "#26322c")]
    return p


def footer(p: list[str], left: str, second: str = "") -> None:
    p += [line(92, 920, 1508, 920, "#26322c"), text(92, 952, left, 16, PAPER, "600")]
    if second:
        p.append(text(92, 978, second, 15, MUTED))
    p.append(text(1508, 978 if second else 952, "supabase.com", 13, FAINT, "600", "end", .5))


def legends(p: list[str], labels: tuple[str, str] = ("LEGACY CLI", "NEW CLI")) -> None:
    p += [rect(92, 307, 16, 16, BASE, 4), text(120, 321, labels[0], 13, MUTED, "700", letter=.7),
          rect(340, 307, 16, 16, GREEN, 4), text(368, 321, labels[1], 13, GREEN_SOFT, "700", letter=.7)]


def ratio_chart(out: Path, name: str, eyebrow: str, headline: str, subtitle: str,
                groups: list[dict[str, Any]], caption: str, note: str) -> None:
    p = card_base(eyebrow, headline, subtitle, f"{subtitle} {caption}. Higher ratios indicate faster completion.")
    legends(p)
    left, right, bottom, chart_h = 120, 1480, 770, 330
    ymax = max(1.0, *(g["ratio"] for g in groups))
    unit = chart_h / ymax
    base_y = bottom - unit
    p += [line(left - 20, base_y, right + 20, base_y, "#a0ada5", 1.5, "7 8", .55),
          text(left - 20, base_y - 13, "1× baseline", 16, MUTED, "700", letter=1.2)]
    step = (right - left) / len(groups)
    for i, g in enumerate(groups):
        cx, bw, gap = left + step * (i + .5), 78, 18
        old_h = unit
        new_h = max(5, g["ratio"] * unit)
        bx, nx = cx - bw - gap / 2, cx + gap / 2
        p += [rect(bx, bottom - old_h, bw, old_h, "url(#baseBar)", 9),
              rect(nx, bottom - new_h, bw, new_h, "url(#greenBar)", 9),
              text(nx + bw / 2, bottom - new_h - 17, f'{g["ratio"]:.2f}×', 38, PAPER, "700", "middle"),
              text(cx, 820, g["label"], 19, PAPER, "700", "middle"),
              text(cx, 849, g["old_text"], 16, MUTED, "500", "middle"),
              text(cx, 875, g["new_text"], 16, GREEN_SOFT, "600", "middle")]
    footer(p, caption, note)
    write_chart(out, name, p)


def paired_direct_chart(out: Path, name: str, eyebrow: str, headline: str, subtitle: str,
                        groups: list[dict[str, Any]], unit: str, caption: str, note: str) -> None:
    p = card_base(eyebrow, headline, subtitle, f"{subtitle} Values are {unit}. {caption}")
    legends(p)
    ceiling = (int(max(max(g["old"], g["new"]) for g in groups) / 1000) + 1) * 1000
    left, width, bottom = 150, 1330, 770
    ticks = max(1, int(ceiling / 1000))
    for i in range(ticks + 1):
        val, y = i * 1000, bottom - 400 * i / ticks
        p += [line(left, y, left + width, y, "#53615a", 1, "6 10", .4),
              text(left - 18, y + 5, f"{val:,.0f}", 14, MUTED, "500", "end")]
    p.append(text(92, 367, unit, 15, MUTED, "700"))
    step = width / len(groups)
    for i, g in enumerate(groups):
        cx, bw, gap = left + step * (i + .5), 70, 16
        for x, key, fill in ((cx - bw - gap / 2, "old", "url(#baseBar)"),
                             (cx + gap / 2, "new", "url(#greenBar)")):
            val = g[key]
            h = val / ceiling * 400
            p += [rect(x, bottom - h, bw, h, fill, 8),
                  text(x + bw / 2, bottom - h - 14, g[f"{key}_text"], 18, PAPER, "700", "middle")]
        p += [text(cx, 817, g["label"], 18, PAPER, "700", "middle"),
              text(cx, 847, g.get("detail", ""), 15, MUTED, "500", "middle")]
    footer(p, caption, note)
    write_chart(out, name, p)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="Base report directory")
    args = parser.parse_args()
    data = json.loads(args.data.read_text(encoding="utf-8"))
    if data.get("format") != "supabase-cli-benchmark-report-data-v1":
        raise ValueError("unsupported report data format")
    stack = data["stack"]
    stack_by_key = {(r["implementation"], r["platform"], r["mode"], r["runtime"]): r for r in stack}
    schema_out, stack_out = args.output / "schema" / "assets", args.output / "stack" / "assets"
    samples = data["campaign"]["expected_samples_per_group"]
    caption = f"Median of {samples} samples per group · higher ratio = faster"
    note = "Linux x86_64; readiness ends when services are ready."

    # Cached readiness compares each new Linux runtime to the Linux Docker legacy baseline.
    groups = []
    old = stack_by_key[("legacy", "linux-x64", "default", "docker")]["cached_ready_ms"]["median"]
    for runtime in ("docker", "native"):
        r = stack_by_key[("new", "linux-x64", "default", runtime)]
        new = r["cached_ready_ms"]["median"]
        groups.append({"label": f"Linux · {runtime.title()}", "ratio": old / new,
                       "old_text": f"Legacy Docker {old / 1000:.1f}s", "new_text": f"New {new / 1000:.1f}s"})
    cache_max = max(g["ratio"] for g in groups)
    ratio_chart(stack_out, "cached-default", "LOCAL STACK · DEFAULT MODE · CACHED READINESS",
                f"Up to {cache_max:.1f}× faster starts", "Cached images · database ready · Linux x86_64.",
                groups, caption, "New: database ready · legacy: full stack ready · same Linux platform.")

    groups = []
    for mode in ("eager", "eager-pooler"):
        old_mode = "default" if mode == "eager" else "eager-pooler"
        old = stack_by_key[("legacy", "linux-x64", old_mode, "docker")]["cached_ready_ms"]["median"]
        for runtime in ("docker", "native"):
            new = stack_by_key[("new", "linux-x64", mode, runtime)]["cached_ready_ms"]["median"]
            groups.append({"label": f"{runtime.title()} · {'pooler' if mode == 'eager-pooler' else 'no pooler'}",
                           "ratio": old / new, "old_text": f"Legacy {old / 1000:.1f}s",
                           "new_text": f"New {new / 1000:.1f}s"})
    eager_max = max(g["ratio"] for g in groups)
    ratio_chart(stack_out, "cached-eager", "LOCAL STACK · EAGER MODE · CACHED READINESS",
                f"Up to {eager_max:.1f}× faster full starts", "All enabled services ready · cached artifacts · Linux x86_64.",
                groups, caption, "No-pooler uses legacy default; pooler uses legacy eager-pooler.")

    groups = []
    comparisons = [("Docker · default", "docker", "default"),
                   ("Native · default", "native", "default"),
                   ("Docker · eager", "docker", "eager"),
                   ("Native · eager", "native", "eager")]
    for label, runtime, mode in comparisons:
        new = stack_by_key[("new", "linux-x64", mode, runtime)]["cold_ready_ms"]["median"]
        old = stack_by_key[("legacy", "linux-x64", "default", "docker")]["cold_ready_ms"]["median"]
        groups.append({"label": label, "ratio": old / new,
                       "old_text": f"Legacy Docker {old / 1000:.1f}s", "new_text": f"New {new / 1000:.1f}s"})
    eager_docker = stack_by_key[("new", "linux-x64", "eager", "docker")]["cold_ready_ms"]["median"]
    ratio_chart(stack_out, "cold-startup", "LOCAL STACK · COLD READINESS",
                f"{old / 1000:.0f}s → {eager_docker / 1000:.0f}s full startup",
                "Docker eager: downloads, extraction and fresh database initialization included.",
                groups, caption, "Default: database ready · eager and legacy: full stack ready · Linux x86_64.")

    payload_groups = []
    for runtime in ("docker", "native"):
        for mode in ("default", "eager-pooler"):
            old_mode = "default" if mode == "default" else "eager-pooler"
            old = stack_by_key[("legacy", "linux-x64", old_mode, "docker")]["payload"]["compressed_payload_bytes"]["median"]
            new = stack_by_key[("new", "linux-x64", mode, runtime)]["payload"]["compressed_payload_bytes"]["median"]
            old_mib, new_mib = old / (1024**2), new / (1024**2)
            payload_groups.append({"label": f"{runtime.title()} · {'pooler' if mode == 'eager-pooler' else 'no pooler'}", "old": old_mib, "new": new_mib,
                                   "old_text": f"{old_mib:,.0f}", "new_text": f"{new_mib:,.0f}",
                                   "detail": "Legacy / new MiB"})
    payload_reduction = max((g["old"] - g["new"]) / g["old"] for g in payload_groups) * 100
    paired_direct_chart(stack_out, "payload-size", "LOCAL STACK · DOWNLOAD METADATA",
                        f"Up to {payload_reduction:.0f}% smaller payload", "Metadata-derived payload; not measured network traffic.",
                        payload_groups, "MiB", f"Exact compressed payload bytes from metadata · n={samples} samples.",
                        "Linux legacy Docker baseline; eager mode includes the pooler.")

    default_rss = []
    for runtime in ("docker", "native"):
        r = stack_by_key[("new", "linux-x64", "default", runtime)]
        old = stack_by_key[("legacy", "linux-x64", "default", "docker")]["idle_rss"]["rss_mib"]["median"]
        new = r["idle_rss"]["rss_mib"]["median"]
        default_rss.append({"label": f"Linux · {runtime.title()}", "old": old, "new": new,
                            "old_text": f"{old:,.0f}", "new_text": f"{new:,.0f}", "detail": "Legacy / new MiB"})
    default_reduction = max((g["old"] - g["new"]) / g["old"] for g in default_rss) * 100
    paired_direct_chart(stack_out, "memory-default-rss", "LOCAL STACK · DEFAULT MODE · PROCESS RSS",
                        f"About {default_reduction:.0f}% lower idle RSS", "Database running; other services dormant. Legacy starts its full stack.",
                        default_rss, "MiB", f"Lower is less process RSS · n={samples} samples.",
                        "Legacy Docker baseline; Docker includes host and container RSS, engine and VM excluded.")
    eager_rss = []
    for runtime in ("docker", "native"):
        for mode in ("eager", "eager-pooler"):
            r = stack_by_key[("new", "linux-x64", mode, runtime)]
            old_mode = "default" if mode == "eager" else "eager-pooler"
            old = stack_by_key[("legacy", "linux-x64", old_mode, "docker")]["idle_rss"]["rss_mib"]["median"]
            new = r["idle_rss"]["rss_mib"]["median"]
            mode_label = "pooler" if mode == "eager-pooler" else "no pooler"
            eager_rss.append({"label": f"{runtime.title()} · {mode_label}", "old": old, "new": new,
                              "old_text": f"{old:,.0f}", "new_text": f"{new:,.0f}", "detail": "Legacy / new MiB"})
    paired_direct_chart(stack_out, "memory-eager-rss", "LOCAL STACK · EAGER MODE · PROCESS RSS",
                        "Full-stack RSS: mixed results", "Summed resident process memory; eager runs may increase RSS.",
                        eager_rss, "MiB", f"Lower is less process RSS · n={samples} samples.",
                        "No-pooler uses legacy default; pooler uses legacy eager-pooler; Docker host and container RSS.")

    commands = data["schema_commands"]
    def command(implementation: str, runtime: str, label: str) -> dict[str, Any]:
        found = [r for r in commands if r["implementation"] == implementation and r["runtime"] == runtime
                 and r["label"] == label and r["platform"].startswith("Linux-")]
        if len(found) != 1:
            raise ValueError(f"expected one command row for {implementation}/{runtime}/{label}; got {len(found)}")
        return found[0]

    for chart_name, operation in (("db-diff", "db-diff.changed"), ("declarative-loop", "declarative.no-change.repeat")):
        groups = []
        for size in ("small", "large"):
            for runtime in ("docker", "native"):
                label = f"{size}.{operation}"
                new = command("new", runtime, label)["duration_ms"]["median"]
                old = command("legacy", "docker", label)["duration_ms"]["median"]
                ratio = old / new
                old_text, new_text = f"Legacy Docker {old / 1000:.2f}s", f"New {new / 1000:.2f}s"
                groups.append({"label": f"{size.title()} · {runtime.title()}", "ratio": ratio,
                               "old_text": old_text, "new_text": new_text})
        max_ratio = max(g["ratio"] for g in groups)
        ratio_chart(schema_out, chart_name, f"SCHEMA WORKFLOW · {operation.split('.')[0].upper()}",
                    f"Up to {max_ratio:.1f}× faster db diff" if chart_name == "db-diff" else f"Up to {max_ratio:.1f}× faster repeat checks",
                    "Median command duration by schema size and runtime.", groups,
                    f"Median of {samples} successful samples per group · higher ratio = faster",
                    "Linux legacy Docker baseline is shared across new Docker and native runtimes.")

    print("Generated stack: cached-default, cached-eager, cold-startup, payload-size, memory-default-rss, memory-eager-rss")
    print("Generated schema: db-diff, declarative-loop")


if __name__ == "__main__":
    main()
