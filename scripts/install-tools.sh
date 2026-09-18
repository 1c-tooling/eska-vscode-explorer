#!/usr/bin/env bash
# Install pinned Linux x64 binaries; no npm bootstrap or Rust compilation is required.
set -euo pipefail

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]]
tool_root="${RUNNER_TEMP:?}/eska-release-tools"
mkdir -p "$tool_root"

# Verify the exact archive before extracting the executable used by later steps.
download() {
  local url="$1" checksum="$2" archive="$3"
  curl --fail --silent --show-error --location --retry 3 "$url" --output "$archive"
  printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status
}

download 'https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip' \
  '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913' "$tool_root/bun.zip"
unzip -qo "$tool_root/bun.zip" -d "$tool_root"
printf '%s\n' "$tool_root/bun-linux-x64" >> "${GITHUB_PATH:?}"

if [[ "${1:-check}" == release ]]; then
  download 'https://github.com/knope-dev/knope/releases/download/knope%2Fv0.23.0/knope-x86_64-unknown-linux-musl.tgz' \
    '76a970a5e237344abc14be3de37ed50c021b659a9b66b3f54afc77e6d48ac501' "$tool_root/knope.tgz"
  tar -xzf "$tool_root/knope.tgz" -C "$tool_root"
  printf '%s\n' "$tool_root/knope-x86_64-unknown-linux-musl" >> "$GITHUB_PATH"
fi
