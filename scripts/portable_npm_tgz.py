#!/usr/bin/env python3
"""Rewrite an npm pack tgz with a pinned gzip stream.

npm's gzip bytes vary by Node/zlib even when the uncompressed tar is
identical (portable mtimes, uid 0). 402security's digest for this tree is
the same tar compressed with zlib level 9, gzip mtime 0, XFL 2, OS 255.
"""

from __future__ import annotations

import gzip
import hashlib
import sys
import zlib
from pathlib import Path


def portable_gzip(tar: bytes) -> bytes:
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    body = compressor.compress(tar) + compressor.flush()
    header = bytes([0x1F, 0x8B, 8, 0, 0, 0, 0, 0, 2, 255])
    crc = zlib.crc32(tar) & 0xFFFFFFFF
    return header + body + crc.to_bytes(4, "little") + (len(tar) & 0xFFFFFFFF).to_bytes(
        4, "little"
    )


def rewrite(path: Path) -> str:
    tar = gzip.decompress(path.read_bytes())
    out = portable_gzip(tar)
    path.write_bytes(out)
    return hashlib.sha256(out).hexdigest()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.stderr.write("usage: portable_npm_tgz.py <file.tgz>\n")
        raise SystemExit(2)
    print(rewrite(Path(sys.argv[1])))
