#!/usr/bin/env python3
"""Point a diagnostic CLI build at a locally loaded candidate Realtime image."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts-source", required=True, type=Path)
    parser.add_argument("--local-image", required=True)
    args = parser.parse_args()
    source = args.artifacts_source.read_text(encoding="utf-8")
    source, count = re.subn(
        r"ghcr\.io/supabase/cli/realtime:v2\.134\.5(?:@sha256:[a-f0-9]{64})?",
        args.local_image,
        source,
    )
    if count != 1:
        parser.error(f"expected one Realtime v2.134.5 image in the source catalog, found {count}")
    args.artifacts_source.write_text(source, encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
