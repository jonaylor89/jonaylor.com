#!/bin/bash
# Render every scene at 1080p30, then join them into one file.
set -euo pipefail
cd "$(dirname "$0")"

# TeX distributions are not always on PATH in a non-login shell.
for texbin in /Library/TeX/texbin "$HOME/Library/TinyTeX/bin/"* "$HOME/.TinyTeX/bin/"*; do
  if [[ -d "$texbin" ]]; then
    export PATH="$texbin:$PATH"
  fi
done

for cmd in uv ffmpeg latex dvisvgm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing dependency: $cmd. See README.md for setup instructions." >&2
    exit 1
  fi
done
uv sync --locked
SCENES="S1Open S2Classic S3Gauss S4Pareto S5Board S6Close"
for s in $SCENES; do uv run --no-sync manim -qh --fps 30 --disable_caching pareto_galton.py "$s"; done
D=media/videos/pareto_galton/1080p30
LIST=$(mktemp ./render-list.XXXXXX)
trap 'rm -f "$LIST" pareto_galton_tmp.mp4' EXIT
for s in $SCENES; do echo "file '$D/$s.mp4'" >> "$LIST"; done
ffmpeg -y -f concat -safe 0 -i "$LIST" -c copy pareto_galton_tmp.mp4
mv pareto_galton_tmp.mp4 pareto_galton.mp4
