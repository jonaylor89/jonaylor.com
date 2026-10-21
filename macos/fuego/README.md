# 🔥 Fuego

A minimal macOS menu bar app that blocks distracting websites and apps while you focus.

- Blocks sites in every browser and app with a system-wide content filter, including subdomains
- Quits distracting apps, and keeps quitting them if they're reopened during a session
- Blocking ends on its own when the timer does
- Updates itself through [Sparkle](https://sparkle-project.org)

Requires macOS 15.5 or later.

## Install

[Download the latest release](https://github.com/jonaylor89/Fuego/releases/latest), or:

```bash
brew install --cask jonaylor89/tap/fuego
```

Move Fuego to Applications and open it from there. The first time you start a session with sites to block, macOS asks you to turn on Fuego's content filter in **System Settings → General → Login Items & Extensions → Network Extensions**, then to allow it to filter network content.

Blocked pages show the browser's connection error. Traffic through a VPN or proxy can get past the filter. Fuego never records or sends what you browse.

## Development

Open `Fuego.xcodeproj` in Xcode. Building needs an Apple Developer account with the Network Extension capability. macOS only activates the filter for apps in `/Applications`, so copy the build there to test website blocking. Check the filter with `systemextensionsctl list` and `log stream --info --predicate 'subsystem BEGINSWITH "dev.getfuego"'`.

CI runs [`macos-fuego.yml`](../../.github/workflows/macos-fuego.yml) on changes under `macos/fuego`. Releases are built by the **Fuego macOS Release** workflow (Actions → Fuego macOS Release), which runs `scripts/release.sh` to sign, notarize, and publish the DMG and Sparkle appcast, then updates the [Homebrew tap](https://github.com/jonaylor89/homebrew-tap). Releases are still published to [jonaylor89/Fuego](https://github.com/jonaylor89/Fuego/releases), where installed copies look for updates. The secrets it needs are listed in [`macos-fuego-release.yml`](../../.github/workflows/macos-fuego-release.yml).

The website lives in [`apps/fuego`](../../apps/fuego) and deploys with `pnpm --filter fuego-site deploy`.

[Website](https://getfuego.dev) · [Issues](https://github.com/jonaylor89/jonaylor.com/issues)
