"""Lossless transport compression for repeated immutable parent frontiers.

The ZIP still has the same expansion bounds. Version-2 manifests intern repeated
parent arrays; expansion restores the EXACT original changes/operation payloads
before validation or UUID fingerprinting. Old readers reject format 2 safely.
"""
from __future__ import annotations

import hashlib
import re
import uuid
from collections import Counter

MAX_EDGES = 8_000_000


def digest(parents):
    return hashlib.sha256("\n".join(parents).encode("ascii")).hexdigest()


def _changes(manifest):
    yield from manifest.get("contact_history", [])
    for key in ("ops", "results"):
        for op in manifest.get(key, []):
            if op.get("kind") == "contact_change":
                yield op["payload"]


def compact(manifest):
    counts = Counter(tuple(c.get("parents", [])) for c in _changes(manifest))
    repeated = {p: digest(p) for p, count in counts.items() if count > 1 and len(p) > 1}
    if not repeated:
        return manifest
    def change(c):
        frontier = repeated.get(tuple(c.get("parents", [])))
        if frontier is None: return c
        return {k: v for k, v in c.items() if k != "parents"} | {"parent_frontier": frontier}
    result = dict(manifest)
    if "contact_history" in result: result["contact_history"] = [change(c) for c in result["contact_history"]]
    for key in ("ops", "results"):
        if key in result:
            result[key] = [op | {"payload": change(op["payload"])} if op.get("kind") == "contact_change" else op for op in result[key]]
    return result | {"format": 2, "contact_wire": 1, "contact_frontiers": {h: list(p) for p, h in repeated.items()}}


def expand(manifest):
    if manifest.get("format") == 1:
        if manifest.get("contact_frontiers") or any("parent_frontier" in c for c in _changes(manifest)):
            raise ValueError("Contact frontier references require transfer format 2")
        return manifest
    if manifest.get("format") != 2 or manifest.get("contact_wire") != 1:
        raise ValueError("Unsupported contact wire format")
    frontiers = manifest.get("contact_frontiers")
    if not isinstance(frontiers, dict) or len(frontiers) > 100_000:
        raise ValueError("Invalid contact frontier table")
    total, checked = 0, set()
    for key, parents in frontiers.items():
        if not isinstance(key, str) or re.fullmatch(r"[a-f0-9]{64}", key) is None or not isinstance(parents, list) or len(parents) > 100_000:
            raise ValueError("Invalid contact frontier")
        total += len(parents)
        if total > MAX_EDGES: raise ValueError("Contact frontier table exceeds supported size")
        for parent in parents:
            if not isinstance(parent, str): raise ValueError("Invalid parent UUID")
            if parent not in checked:
                if str(uuid.UUID(parent)) != parent: raise ValueError("Invalid parent UUID")
                checked.add(parent)
        if len(set(parents)) != len(parents) or digest(parents) != key:
            raise ValueError("Contact frontier digest does not match its parents")
    expanded = 0
    def change(c):
        nonlocal expanded
        if not isinstance(c, dict): raise ValueError("Invalid contact change")
        ref = c.get("parent_frontier")
        if "parent_frontier" in c:
            if not isinstance(ref, str) or ref not in frontiers or "parents" in c:
                raise ValueError("Invalid or ambiguous contact frontier reference")
            c = {k: v for k, v in c.items() if k != "parent_frontier"} | {"parents": frontiers[ref]}
        parents = c.get("parents", [])
        if not isinstance(parents, list): raise ValueError("Invalid contact parents")
        expanded += len(parents)
        # History and delivery receipts may contain the same immutable changes.
        if expanded > MAX_EDGES * 3: raise ValueError("Expanded contact frontiers exceed supported size")
        return c
    result = dict(manifest)
    if "contact_history" in result: result["contact_history"] = [change(c) for c in result["contact_history"]]
    for key in ("ops", "results"):
        if key in result:
            result[key] = [op | {"payload": change(op["payload"])} if op.get("kind") == "contact_change" else op for op in result[key]]
    result.pop("contact_frontiers", None)
    result["format"] = 1
    return result
