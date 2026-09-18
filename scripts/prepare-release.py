#!/usr/bin/env python3
"""Prepare one immutable release PR in CI, without rewriting branch history."""

import json
import os
import re
import subprocess
from pathlib import Path

REPOSITORY = "1c-tooling/eska-vscode-explorer"


def run(*args: str) -> str:
    """Execute literal arguments and propagate failures instead of hiding remote errors."""
    return subprocess.check_output(args, text=True).strip()


def prepare() -> None:
    """Generate version files with Knope and create a PR only when the staged tree changes."""
    if os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise RuntimeError("This publishing helper runs only in its own GitHub Actions repository")
    if run("git", "status", "--porcelain"):
        raise RuntimeError("Release preparation requires a clean checkout")
    base = run("git", "rev-parse", "HEAD")
    run("knope", "prepare-release")
    changed = run("git", "diff", "--cached", "--name-only").splitlines()
    if not changed:
        print("No version changes to propose.")
        return
    if set(changed) != {"package.json", "CHANGELOG.md"}:
        raise RuntimeError(f"Unexpected release changes: {changed}")
    version = json.loads(Path("package.json").read_text())["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise RuntimeError("Only stable three-part extension versions are supported")
    tree = run("git", "write-tree")
    branch = f"release/eska-explorer-{version}-{base[:12]}-{tree[:8]}"
    existing = run("git", "ls-remote", "--heads", "origin", f"refs/heads/{branch}")
    if not existing:
        run("git", "switch", "-c", branch)
        run("git", "commit", "-m", f"chore(release): Подготовлена версия {version}")
        run("git", "push", "--set-upstream", "origin", branch)
    else:
        # An identical rerun reuses the existing branch; unexpected edits are never overwritten.
        run("git", "fetch", "origin", f"refs/heads/{branch}")
        if run("git", "rev-parse", "FETCH_HEAD^{tree}") != tree:
            raise RuntimeError("The existing release branch differs from the generated tree")

    pulls = json.loads(run("gh", "pr", "list", "--repo", REPOSITORY, "--state", "open",
                          "--base", "main", "--limit", "100", "--json", "number,headRefName"))
    current = next((pr for pr in pulls if pr["headRefName"] == branch), None)
    if current is None:
        body = Path(os.environ["RUNNER_TEMP"]) / "eska-release-pr.md"
        body.write_text(
            f"Обновляет версию расширения до {version} и CHANGELOG.md по Conventional Commits.\n\n"
            "После слияния GitHub Actions проверит эту версию и создаст GitHub Release. "
            "Публикация в Marketplace не выполняется.\n\n"
            "Проверки этого commit запускаются отдельным workflow CI.\n", encoding="utf-8")
        run("gh", "pr", "create", "--repo", REPOSITORY, "--base", "main", "--head", branch,
            "--title", f"chore(release): Подготовлена версия {version}", "--body-file", str(body))

    # GITHUB_TOKEN-created PR runs may require approval; dispatch provides explicit CI.
    run("gh", "workflow", "run", "ci.yml", "--repo", REPOSITORY, "--ref", branch)
    for pr in pulls:
        if pr["headRefName"] != branch and pr["headRefName"].startswith("release/eska-explorer-"):
            run("gh", "pr", "close", str(pr["number"]), "--repo", REPOSITORY)
    print(f"Prepared {branch}")


if __name__ == "__main__":
    prepare()
