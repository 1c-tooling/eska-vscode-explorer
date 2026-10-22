#!/usr/bin/env bash
# Use one verified VS Code build for native language checks in an isolated profile.
set -euo pipefail
editor_root="${RUNNER_TEMP:?}/eska-test-editor"
mkdir -p "$editor_root"
curl --fail --silent --show-error --location --retry 3 \
  'https://vscode.download.prss.microsoft.com/dbazure/download/stable/2d0b7506a36c1d6db9a466440131a8e01eab2289/code-stable-x64-1792533330.tar.gz' \
  --output "$editor_root/editor.tar.gz"
printf '%s  %s\n' '89302bd9631307a49f3b18a570ce588bf7c53aa4169bf4fb36051a6e76f5e205' "$editor_root/editor.tar.gz" | sha256sum --check --status
tar -xzf "$editor_root/editor.tar.gz" -C "$editor_root"
# Archive extraction does not configure the root-owned SUID helper required on the CI runner.
sudo chown root:root "$editor_root/VSCode-linux-x64/chrome-sandbox"
sudo chmod 4755 "$editor_root/VSCode-linux-x64/chrome-sandbox"
printf 'VSCODE_EXECUTABLE=%s\n' "$editor_root/VSCode-linux-x64/bin/code" >> "${GITHUB_ENV:?}"
