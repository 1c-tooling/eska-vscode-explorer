#!/usr/bin/env python3
"""Identify a prepared release version; zero is the unreleased scaffold."""

import json
import re
from pathlib import Path


def release_version(root: Path) -> str | None:
    """Require a matching generated changelog heading before permitting publication."""
    version = json.loads((root / "package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Extension version must have three numeric components")
    if version == "0.0.0":
        return None
    text = (root / "CHANGELOG.md").read_text()
    if not re.search(rf"^## {re.escape(version)} \(\d{{4}}-\d{{2}}-\d{{2}}\)$", text, re.MULTILINE):
        raise ValueError("The current version has no Knope changelog entry")
    return version


if __name__ == "__main__":
    print(release_version(Path.cwd()) or "")
