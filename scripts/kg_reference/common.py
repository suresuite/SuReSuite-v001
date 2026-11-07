"""Shared plumbing for the Phase 19 reference datasets (docs/PLAN.md §29, WP 19.4).

What this module does NOT do, on purpose: normalize or match names. Identity
is decided once, by the resolver that WP 19.1 adds beside
supabase/functions/_shared/networkEvidence.ts (gate `single-source`). These
extractors record what a document says — the raw name, any registry id it
prints, the page, and a short verbatim fragment — and nothing else.

Documents are cached OUTSIDE the repository (KG_CACHE, default
~/.cache/suresuite-kg) and never committed; sources.json records each one's
URL, retrieval date and sha256, so a rebuild can prove it read the same bytes.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
SOURCES = HERE / "sources.json"
CACHE = Path(os.environ.get("KG_CACHE", Path.home() / ".cache" / "suresuite-kg"))
# A generic client name: no personal contact details in request headers.
USER_AGENT = "SuReSuite-research-bot/0.1 (supply-chain research)"
FRAGMENT_MAX = 200  # the verbatim-evidence ceiling: a fact's quote, never a copy of the page
POLITE_DELAY_S = 6.0


def fragment(text: str) -> str:
    """A short verbatim quote, whitespace collapsed, capped at FRAGMENT_MAX."""
    s = " ".join(str(text or "").split())
    return s if len(s) <= FRAGMENT_MAX else s[: FRAGMENT_MAX - 1] + "…"


def clean(text) -> str:
    return " ".join(str(text or "").split())


def load_sources() -> dict:
    return json.loads(SOURCES.read_text()) if SOURCES.exists() else {"sources": []}


def fetch(source_id: str, url: str, filename: str, publisher: str, licence_note: str,
          *, refresh: bool = False) -> Path:
    """Download once into the cache (politely, backing off on 429), record it in
    sources.json, and return the cached path. A recorded sha256 that no longer
    matches the cached bytes is an error: the document changed under us."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / filename
    manifest = load_sources()
    entry = next((s for s in manifest["sources"] if s["id"] == source_id), None)
    if refresh or not path.exists():
        for attempt in range(6):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                path.write_bytes(urllib.request.urlopen(req, timeout=120).read())
                break
            except urllib.error.HTTPError as e:
                if e.code != 429:
                    raise
                time.sleep(int(e.headers.get("Retry-After") or 30 * (attempt + 1)))
        else:
            raise RuntimeError(f"rate-limited: {url}")
        time.sleep(POLITE_DELAY_S)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if entry and entry["sha256"] != digest and not refresh:
        raise RuntimeError(f"{source_id}: cached bytes differ from sources.json — re-run with refresh")
    new = {"id": source_id, "url": url, "publisher": publisher, "sha256": digest,
           "bytes": path.stat().st_size,
           "retrieved_at": entry["retrieved_at"] if entry and entry["sha256"] == digest
           else time.strftime("%Y-%m-%d"),
           "licence_note": licence_note}
    manifest["sources"] = sorted([s for s in manifest["sources"] if s["id"] != source_id] + [new],
                                 key=lambda s: s["id"])
    SOURCES.write_text(json.dumps(manifest, indent=1, ensure_ascii=False) + "\n")
    return path


def write_dataset(name: str, payload: dict, *, check: bool) -> bool:
    """Write data/<name>.json, or with check=True compare and report drift."""
    out = DATA / f"{name}.json"
    text = json.dumps(payload, indent=1, ensure_ascii=False, sort_keys=False) + "\n"
    if check:
        same = out.exists() and out.read_text() == text
        print(f"{'✓' if same else '✗'} data/{name}.json {'is current' if same else 'differs from a rebuild'}")
        return same
    DATA.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"wrote data/{name}.json ({len(payload['entities'])} entities, {len(payload['assertions'])} assertions)")
    return True
