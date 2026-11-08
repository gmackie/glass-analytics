#!/usr/bin/env bash
# Installs the CI toolchain (Node and uv) without the GitHub API (DATFLR-10).
#
# actions/setup-node and astral-sh/setup-uv resolve versions through api.github.com, anonymously on
# our shared Forgejo runner (Forgejo's token is not a GitHub token), so a busy hour exhausted the
# runner IP's 60 requests and failed CI before any check ran. This fetches pinned releases from
# their own distribution points instead and verifies each against a SHA-256 pinned here:
#
#   Node  nodejs.org/dist (the official tarball)
#   uv    pypi.org (the manylinux wheel, unpacked with Python's zipfile; no pip needed)
#
# uv still downloads Python itself when a job asks for one (`uv run --python 3.13`); that is a
# release download, not an API call, and is not rate limited.
#
# Usage in a workflow step:  bash scripts/ci-toolchain.sh
# It adds both to $GITHUB_PATH for later steps. Bump a version by updating its URL and digest.
set -euo pipefail

NODE_VERSION=22.23.4
NODE_SHA256=1805bcd35e6815559bd2eb97db438d3fdb0eb3a5e6a977b7c1badca76337e9ce
UV_VERSION=0.13.7
UV_WHEEL_URL=https://files.pythonhosted.org/packages/b9/93/0e053a2ca4523ee9825ccbedeb7121470d0a188933f11688b6d90d7f5c08/uv-0.13.7-py3-none-manylinux_2_17_x86_64.manylinux2014_x86_64.whl
UV_SHA256=2c9bdc4a872b60a93c5f26c0791089ea11585a4f9d3b3c017d78eb8487505e25

if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
  echo "ci-toolchain.sh pins linux-x64 artifacts; this runner is $(uname -s)-$(uname -m)" >&2
  exit 1
fi

root="${RUNNER_TEMP:-/tmp}/ci-toolchain"
mkdir -p "$root"

fetch() { # url dest sha256
  curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  echo "$3  $2" | sha256sum -c --quiet -
}

# Node
node_dir="$root/node-v$NODE_VERSION-linux-x64"
if [ ! -x "$node_dir/bin/node" ]; then
  fetch "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" "$root/node.tar.xz" "$NODE_SHA256"
  tar -xJf "$root/node.tar.xz" -C "$root"
  rm "$root/node.tar.xz"
fi

# uv: the binary is in the wheel's data directory.
uv_dir="$root/uv-$UV_VERSION"
if [ ! -x "$uv_dir/uv" ]; then
  fetch "$UV_WHEEL_URL" "$root/uv.whl" "$UV_SHA256"
  mkdir -p "$root/uv-wheel" "$uv_dir"
  python3 -m zipfile -e "$root/uv.whl" "$root/uv-wheel"
  install -m 0755 "$root/uv-wheel/uv-$UV_VERSION.data/scripts/uv" "$uv_dir/uv"
  rm -rf "$root/uv.whl" "$root/uv-wheel"
fi

echo "$node_dir/bin" >> "${GITHUB_PATH:-/dev/null}"
echo "$uv_dir" >> "${GITHUB_PATH:-/dev/null}"
export PATH="$node_dir/bin:$uv_dir:$PATH"
echo "node $(node --version), uv $(uv --version | cut -d' ' -f2)"
