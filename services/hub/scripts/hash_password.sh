#!/usr/bin/env bash
# Usage: ./scripts/hash_password.sh <password>
# Generates an Argon2id hash matching the app's parameters (m=15000, t=2, p=1).

set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <password>" >&2
  exit 1
fi

cd "$(dirname "$0")/.."

cargo run --quiet --example hash_password -- "$1"
