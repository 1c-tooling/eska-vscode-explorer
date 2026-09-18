#!/usr/bin/env python3
"""Attach a VSIX built from the release tag, without replacing existing assets."""

import argparse
import json
import os
import re
import subprocess
import tarfile
import tempfile
from pathlib import Path

REPOSITORY = "1c-tooling/eska-vscode-explorer"


def run(*args, cwd=None):
    """Pass literal arguments to tools and propagate every build/API failure."""
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def stage_tag(version, destination):
    """Export only the tagged tree, even when main already contains newer changes."""
    tag = f"refs/tags/v{version}"
    manifest = json.loads(run("git", "show", f"{tag}:package.json"))
    if (manifest.get("version"), manifest.get("name"), manifest.get("publisher")) != (
            version, "eska-explorer", "1c-tooling"):
        raise RuntimeError("Release tag and extension identity/version differ")
    archive = destination / "source.tar"
    run("git", "archive", "--format=tar", f"--output={archive}", tag)
    source = destination / "source"
    source.mkdir()
    with tarfile.open(archive) as tree:
        tree.extractall(source, filter="data")
    return source


def publish(version):
    """Build missing assets from the immutable tag; reruns preserve published packages."""
    if not re.fullmatch(r"\d+\.\d+\.\d+", version) or version == "0.0.0":
        raise ValueError("Expected a released three-part version")
    release = json.loads(run("gh", "release", "view", f"v{version}", "--repo", REPOSITORY,
                             "--json", "isDraft,assets"))
    if release["isDraft"]:
        raise RuntimeError("Expected an existing published release")
    filename = f"eska-explorer-{version}.vsix"
    existing = next((asset for asset in release["assets"] if asset["name"] == filename), None)
    if existing is not None:
        if existing.get("state") != "uploaded" or existing.get("size", 0) <= 0:
            raise RuntimeError("Existing VSIX asset is incomplete; inspect it before retrying")
        print(f"Already attached: {filename}")
        return
    with tempfile.TemporaryDirectory(prefix="eska-release-vsix-", dir=os.environ.get("RUNNER_TEMP")) as directory:
        source = stage_tag(version, Path(directory))
        for args in [("bun", "install", "--frozen-lockfile", "--ignore-scripts"),
                     ("bun", "run", "package"),
                     ("python3", "scripts/check-vsix.py", filename)]:
            run(*args, cwd=source)
        run("gh", "release", "upload", f"v{version}", str(source / filename), "--repo", REPOSITORY)
    print(f"Attached: {filename}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    publish(parser.parse_args().version)
