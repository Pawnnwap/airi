#!/usr/bin/env python3
"""Export the Kokoro TTS model files from a Chromium Cache Storage profile.

The stage's Kokoro voice runs fully in-browser (kokoro-js + transformers.js).
Out of the box those fetch their weights from huggingface.co at runtime,
which fails on machines without access to that host. Once ANY browser has
loaded the voice successfully, the exact working files sit in that browser's
Cache Storage on disk - this tool carves them out into the offline mirror
under apps/stage-web/public/models/hf, which the kokoro worker prefers
(env.localModelPath), so every later load needs no network at all.

Usage:
  python scripts/export-kokoro-cache.py [--profile PATH] [--out PATH]

--profile  a Chromium profile directory containing
           <profile>/Service Worker/CacheStorage (defaults to the ZCode
           in-app browser partition)
--out      target directory (defaults to apps/stage-web/public/models/hf)

Chromium cache_storage side files are [<header><url><body><trailing header
block>]; body length is recovered from the trailing content-length header,
so the carve is byte-exact.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

DEFAULT_PROFILE = Path.home() / "AppData/Roaming/ZCode/session/Partitions/zcode-embedded-browser"
REPO = "onnx-community/Kokoro-82M-v1.0-ONNX"
URL = f"https://huggingface.co/{REPO}/resolve/main/"
URL_CHARS = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~:/?#[]@!$&'()*+,;=%"

WANTED_JSON = {"tokenizer.json", "tokenizer_config.json", "config.json"}


def carve(path: Path) -> tuple[str, int, int, bytes]:
    data = path.read_bytes()
    u = data.find(b"https://")
    if u < 0:
        raise ValueError(f"no url in {path}")
    i = u
    while i < len(data) and data[i:i + 1] in URL_CHARS:
        i += 1
    url = data[u:i].decode()
    m = re.search(rb"content-length\D*(\d+)", data[-3000:], re.I)
    if not m:
        raise ValueError(f"no content-length in {path}")
    n = int(m.group(1))
    return url, i, n, data


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent.parent / "apps/stage-web/public/models/hf")
    args = ap.parse_args()

    root = args.profile / "Service Worker/CacheStorage"
    if not root.is_dir():
        print(f"profile cache storage not found: {root}", file=sys.stderr)
        return 1

    exported = 0
    for side in root.glob("*/*/*_0"):
        try:
            url, start, n, data = carve(side)
        except ValueError:
            continue
        if not url.startswith(URL):
            continue
        rel = url[len(URL):]
        if rel in WANTED_JSON:
            s = data.find(b"{", start)
            e = data.rfind(b"}")
            body = data[s:e + 1]
            json.loads(body)   # validate
        elif rel == "onnx/model.onnx":
            body = data[start:start + n]
            if len(body) != n or not body.startswith(b"\x08"):
                continue
        elif rel.startswith("voices/") and rel.endswith(".bin"):
            body = data[start:start + n]
        else:
            continue
        dest = args.out / REPO / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(body)
        print(f"{rel}: {len(body)} bytes")
        exported += 1

    print(f"exported {exported} file(s) into {args.out / REPO}")
    return 0 if exported else 1


if __name__ == "__main__":
    raise SystemExit(main())
