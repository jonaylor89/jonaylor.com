# Pareto Galton board

Manim animation explaining Galton boards and Pareto distributions.

## Setup

Install [uv](https://docs.astral.sh/uv/getting-started/installation/), then:

```sh
# Native dependencies on macOS:
brew install cairo pango pkgconf ffmpeg
brew install --cask font-latin-modern mactex-no-gui
uv sync --locked
```

MacTeX provides `latex`, `dvisvgm`, and the required LaTeX packages. An existing
TinyTeX installation also works; install its additional packages with:

```sh
tlmgr update --self
tlmgr install standalone preview doublestroke relsize fundus-calligra microtype wasysym physics dvisvgm jknapltx rsfs cm-super
```

## Render

```sh
./render.sh
```

This syncs the locked uv environment, renders all six scenes at 1080p/30 fps,
and concatenates them into `pareto_galton.mp4`. The script locates standard
MacTeX and TinyTeX installations automatically.

To preview a single scene (ensure your TeX binaries are on `PATH`):

```sh
# For TinyTeX on macOS, if needed:
export PATH="$HOME/Library/TinyTeX/bin/universal-darwin:$PATH"
uv run manim -ql pareto_galton.py S2Classic
```
