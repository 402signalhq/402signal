"""Shared frontend asset version and final human-page presentation pass.

Fingerprint is the git SHA of the commit being built or started.
This is not a public SHA/status endpoint and never reads FLY_IMAGE_REF.
"""
from __future__ import annotations
import hashlib
import os
import re
import subprocess
from pathlib import Path
from live402.site_chrome import prepare_generated_html

REPO_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = Path(__file__).resolve().parent / "static"
HTML_REVALIDATE = "no-cache, must-revalidate"
ASSET_LONG_CACHE = "public, max-age=31536000, immutable"
ASSET_PATHS = ("/styles.css", "/app.js", "/dashboard.js", "/transparency.js")
ASSET_FILES = tuple(p.lstrip("/") for p in ASSET_PATHS)
_TOKEN = re.compile(r"^[A-Za-z0-9._-]{7,64}$")
_GIT_SHA = re.compile(r"^[0-9a-f]{7,40}$")
_cached: str | None = None


def reset_for_tests() -> None:
    global _cached
    _cached = None


def asset_version() -> str:
    global _cached
    if _cached is None:
        _cached = _resolve()
    return _cached


def versioned_url(path: str, version: str | None = None) -> str:
    raw = path.split("?", 1)[0]
    return "%s?v=%s" % (raw, version or asset_version())


def stamp_html(html: str, version: str | None = None) -> str:
    """Finalize known generated human pages and fingerprint assets, idempotently."""
    ver = version or asset_version()
    out = prepare_generated_html(html)
    for path in ASSET_PATHS:
        stamped = versioned_url(path, ver)
        for attr in ("href", "src"):
            for quote in ('"', "'"):
                needle = "%s=%s%s%s" % (attr, quote, path, quote)
                if needle in out:
                    out = out.replace(needle, "%s=%s%s%s" % (attr, quote, stamped, quote))
    return out


def _resolve() -> str:
    env = _sanitize(os.environ.get("LIVE402_ASSET_VERSION") or "")
    if env:
        return env
    for path in _version_files():
        try:
            text = path.read_text(encoding="utf-8").strip()
        except OSError:
            continue
        token = _sanitize(text)
        if token:
            return token
    git = _git_rev_parse() or _git_head_file()
    return git or _content_fingerprint()


def _version_files() -> list[Path]:
    return [REPO_ROOT / ".asset-version", Path("/app/.asset-version")]


def _sanitize(raw: str) -> str:
    text = (raw or "").strip()
    if not text:
        return ""
    text = text.split()[0]
    if not text or "/" in text or ":" in text:
        return ""
    low = text.lower()
    if "fly_image" in low or "registry.fly" in low or low.startswith("deployment-"):
        return ""
    if not _TOKEN.match(text):
        return ""
    return low if _GIT_SHA.fullmatch(low) else text


def _git_rev_parse() -> str:
    try:
        proc = subprocess.run(["git", "rev-parse", "HEAD"], cwd=str(REPO_ROOT), capture_output=True, text=True, timeout=2, check=False)
    except (OSError, subprocess.SubprocessError):
        return ""
    return _sanitize(proc.stdout) if proc.returncode == 0 else ""


def _git_head_file(root: Path | None = None) -> str:
    repo = root or REPO_ROOT
    head = repo / ".git" / "HEAD"
    try:
        raw = head.read_text(encoding="utf-8").strip()
    except OSError:
        return ""
    if raw.startswith("ref:"):
        ref = raw.split(":", 1)[1].strip()
        try:
            return _sanitize((repo / ".git" / ref).read_text(encoding="utf-8"))
        except OSError:
            return _sanitize(_packed_ref(repo, ref))
    return _sanitize(raw)


def _packed_ref(repo: Path, ref: str) -> str:
    try:
        lines = (repo / ".git" / "packed-refs").read_text(encoding="utf-8").splitlines()
    except OSError:
        return ""
    for line in lines:
        if not line or line.startswith("#") or " " not in line:
            continue
        sha, name = line.split(" ", 1)
        if name.strip() == ref:
            return sha.strip()
    return ""


def _content_fingerprint() -> str:
    digest = hashlib.sha256()
    for name in ASSET_FILES:
        path = STATIC_DIR / name
        digest.update(name.encode("utf-8"))
        digest.update(b"\0")
        try:
            digest.update(path.read_bytes())
        except OSError:
            digest.update(b"missing")
        digest.update(b"\0")
    return "static-%s" % digest.hexdigest()[:12]
