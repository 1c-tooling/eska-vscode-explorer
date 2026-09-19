#!/usr/bin/env python3
"""Validate a GitHub release VSIX and explicitly publish it to Open VSX."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from urllib.error import HTTPError
from urllib.request import urlopen

REPOSITORY = "1c-tooling/eska-vscode-explorer"


def run(*args):
    """Execute literal arguments without shell expansion or credential logging."""
    return subprocess.check_output(args, text=True).strip()


def validate_package(path, version, manifest):
    """Match both VSIX identities and the tagged manifest before giving a registry any bytes."""
    if (manifest.get("publisher"), manifest.get("name"), manifest.get("version")) != ("1c-tooling", "eska-explorer", version):
        raise ValueError("Unexpected tagged extension identity/version")
    with zipfile.ZipFile(path) as package:
        names = package.namelist()
        if len(names) != len(set(names)) or package.testzip() is not None:
            raise ValueError("Invalid or duplicate ZIP entries")
        identity = ET.fromstring(package.read("extension.vsixmanifest")).find(".//{*}Identity")
        if identity is None or (identity.get("Publisher"), identity.get("Id"), identity.get("Version")) != ("1c-tooling", "eska-explorer", version):
            raise ValueError("VSIX identity differs from release tag")
        shipped = json.loads(package.read("extension/package.json"))
        if any(shipped.get(key) != value for key, value in manifest.items()):
            raise ValueError("VSIX manifest differs from release tag")
        if not package.read("extension/" + manifest["main"].removeprefix("./")):
            raise ValueError("Missing executable entry point")
        if manifest.get("icon"):
            if not package.read("extension/" + manifest["icon"]).startswith(b"\x89PNG\r\n\x1a\n"):
                raise ValueError("Expected a packaged PNG store icon")


def publish_command(authentication, path):
    """Publish the existing file: never repack it, change its version, or pass tokens in arguments."""
    if authentication not in ("oidc", "token"):
        raise ValueError("Unknown authentication")
    command = ["bun", "run", "--bun", "ovsx", "publish", str(path)]
    if authentication == "oidc":
        command.append("--trusted-publishing")
    return command


def remote_digest(version):
    """Hash the registry's existing universal VSIX; only a missing version permits upload."""
    base = f"https://open-vsx.org/api/1c-tooling/eska-explorer/{version}"
    try:
        response = urlopen(base, timeout=30)
    except HTTPError as error:
        if error.code == 404:
            return None
        raise
    with response:
        metadata = json.load(response)
    if (metadata.get("namespace"), metadata.get("name"), metadata.get("version"), metadata.get("targetPlatform")) != (
            "1c-tooling", "eska-explorer", version, "universal"):
        raise ValueError("Unexpected Open VSX version identity")
    digest = hashlib.sha256()
    with urlopen(f"{base}/file/1c-tooling.eska-explorer-{version}.vsix", timeout=30) as package:
        while chunk := package.read(1024 * 1024):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest()


def publish(version, authentication, dry_run=True):
    """Read the released asset and fail closed on tag, digest, identity or authorization mismatches."""
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version) or version == "0.0.0":
        raise ValueError("Expected a released stable version without the v prefix")
    publish_command(authentication, Path("validation.vsix"))
    if not dry_run and (os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY
                        or os.environ.get("GITHUB_REF") != "refs/heads/main" or os.environ.get("GITHUB_EVENT_NAME") not in ("workflow_dispatch", "push")):
        raise RuntimeError("Publication is allowed only by release push or manual workflow dispatch from main")
    run("git", "merge-base", "--is-ancestor", f"refs/tags/v{version}", "HEAD")
    manifest = json.loads(run("git", "show", f"refs/tags/v{version}:package.json"))
    release = json.loads(run("gh", "api", f"repos/{REPOSITORY}/releases/tags/v{version}"))
    if release.get("draft") is not False or release.get("prerelease") is not False or release.get("tag_name") != f"v{version}":
        raise ValueError("Expected an existing stable published GitHub release")
    filename = f"eska-explorer-{version}.vsix"
    assets = [asset for asset in release["assets"] if asset["name"] == filename]
    if len(assets) != 1 or assets[0].get("state") != "uploaded" or assets[0].get("size", 0) <= 0:
        raise ValueError("Expected exactly one complete released VSIX")
    with tempfile.TemporaryDirectory(prefix="eska-store-", dir=os.environ.get("RUNNER_TEMP")) as directory:
        path = Path(directory) / filename
        run("gh", "release", "download", f"v{version}", "--repo", REPOSITORY, "--pattern", filename, "--dir", directory)
        if path.stat().st_size != assets[0]["size"]:
            raise ValueError("VSIX size differs from release metadata")
        digest = "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()
        if assets[0].get("digest") and assets[0]["digest"] != digest:
            raise ValueError("VSIX digest differs from release metadata")
        validate_package(path, version, manifest)
        print(f"Validated 1c-tooling.eska-explorer@{version}: {digest}", flush=True)
        if dry_run:
            print("Dry run: Open VSX; no publication performed")
            return
        existing = remote_digest(version)
        if existing is not None:
            if existing != digest:
                raise ValueError("Open VSX already contains different bytes for this version")
            print(f"Already published in Open VSX with matching SHA-256: {version}")
            return
        environment = os.environ.copy()
        # OIDC must not silently select an inherited long-lived token instead.
        if authentication == "oidc":
            environment.pop("OVSX_PAT", None)
        elif not environment.get("OVSX_PAT"):
            raise RuntimeError("The selected registry publishing secret is missing")
        subprocess.run(publish_command(authentication, path), env=environment, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("version")
    parser.add_argument("--authentication", choices=("oidc", "token"), default="token")
    parser.add_argument("--publish", action="store_true", help="Actually publish; otherwise validate only")
    arguments = parser.parse_args()
    publish(arguments.version, arguments.authentication, not arguments.publish)
