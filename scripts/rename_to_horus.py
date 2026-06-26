#!/usr/bin/env python3
"""One-shot OSIRIS -> HORUS rename across tracked source files.

Case-preserving (OSIRIS->HORUS, Osiris->Horus, osiris->horus). External
identity (upstream handles/repo, public domains) is protected and left as-is
for the owner to update with their real infrastructure.

Run:  python scripts/rename_to_horus.py
"""
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Files handled separately or intentionally left untouched.
SKIP_FILES = {
    "README.md",            # rewritten fresh
    "LICENSE",              # upstream copyright/attribution — owner decides
    "package-lock.json",    # generated; no internal osiris tokens worth touching
    "scripts/rename_to_horus.py",
}

# Binary / asset extensions never rewritten as text.
BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".webp", ".woff",
              ".woff2", ".ttf", ".otf", ".mp4", ".pdf", ".zip", ".icns"}

# External strings to PRESERVE (do not fabricate new infra). Longest first so
# nested matches (osirisai.live before osirisai) are masked correctly.
PROTECT = sorted([
    "osirisai.live",
    "osirislive.app",
    "osiris.vercel.app",
    "osirisai",
    "simplifaisoul",
    "Aiacos/osiris",
    "aiacos/osiris",
], key=len, reverse=True)


def transform(text: str) -> str:
    # Mask protected externals.
    for i, p in enumerate(PROTECT):
        text = text.replace(p, f"\x00{i}\x00")
    # Case-preserving rename (case-sensitive, no overlap between the three).
    text = text.replace("OSIRIS", "HORUS").replace("Osiris", "Horus").replace("osiris", "horus")
    # Restore protected externals.
    for i, p in enumerate(PROTECT):
        text = text.replace(f"\x00{i}\x00", p)
    return text


def main():
    files = subprocess.check_output(["git", "ls-files"], cwd=ROOT).decode().splitlines()
    changed = []
    skipped_binary = 0
    for rel in files:
        if rel in SKIP_FILES:
            continue
        ext = os.path.splitext(rel)[1].lower()
        if ext in BINARY_EXT:
            skipped_binary += 1
            continue
        path = os.path.join(ROOT, rel)
        try:
            with open(path, "r", encoding="utf-8") as f:
                original = f.read()
        except (UnicodeDecodeError, FileNotFoundError):
            continue
        updated = transform(original)
        if updated != original:
            with open(path, "w", encoding="utf-8", newline="") as f:
                f.write(updated)
            n = sum(1 for a, b in [(original, updated)] for _ in [0]) and \
                (original.lower().count("osiris"))
            changed.append((rel, n))

    print(f"Files changed: {len(changed)} (binary assets skipped: {skipped_binary})")
    for rel, n in sorted(changed, key=lambda x: -x[1])[:25]:
        print(f"  {n:4d}  {rel}")
    total = sum(n for _, n in changed)
    print(f"Total osiris tokens rewritten (approx): {total}")


if __name__ == "__main__":
    main()
