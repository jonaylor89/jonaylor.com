# jonaylor.com

Personal websites, experiments, and self-hosted services maintained by [Johannes Naylor](https://jonaylor.com).

JavaScript apps live in [`apps`](apps), native Android apps in [`android`](android), native macOS apps in [`macos`](macos), Python CLIs in [`cli`](cli), Flutter apps in [`flutter`](flutter), and self-contained Rust services in [`services`](services).

## Getting started

### Prerequisites

- Node.js 22.12 or later
- [pnpm](https://pnpm.io/) 10.32.1 (the version pinned by `packageManager`)
- Rust and Cargo, only when working on a service
- uv, only when working on `cli/mypeople` (Python is pinned by that project's `.python-version`)

```bash
git clone https://github.com/jonaylor89/jonaylor.com.git
cd jonaylor.com
pnpm install
```

## Self-hosting

[`infra/media`](infra/media) contains a portable Docker Compose media stack,
a small validation/bootstrap script, and storage, migration, music import, and backup
instructions. Deployment-specific settings stay in an ignored local `.env` file.

[`infra/services`](infra/services) manages Hub, Redis, Gitea, Uptime Kuma, and an
optional Cloudflare Tunnel. Both stacks use ordinary Docker Compose, pinned images,
and private local configuration; workstation setup stays in the dotfiles repository.

## Pokémon Yellow

`apps/pokemon-yellow` is a browser game with guest saves and optional Better Auth accounts,
backed by a Cloudflare Worker and D1. Its production target is `pokemon-yellow.jonaylor.com`.
See [the app setup/deployment guide](apps/pokemon-yellow/DEPLOYMENT.md). ROMs, prepared assets
and credentials are not part of the source checkout.

```bash
pnpm --filter pokemon-yellow dev
pnpm --filter pokemon-yellow build
pnpm --filter pokemon-yellow test
```

## Development

Run commands from the repository root. Apps are managed with pnpm workspaces and Turborepo.

```bash
# Run all workspace development servers
pnpm dev

# Run, build, or deploy one app
pnpm --filter <app> dev
pnpm --filter <app> build
pnpm --filter <app> deploy

# Build all workspace apps
pnpm build
```

Deployment commands use Wrangler and require Cloudflare credentials configured locally.

### Android

The Android apps are independent Gradle projects and are not pnpm workspaces. They require the Android SDK and the JDK version specified by each project.

```bash
pnpm android:paperclock:build
pnpm android:saintjohn:build
pnpm android:parlo:build
pnpm android:mypeople:build
```

Their GitHub Actions workflows build and publish app-specific releases with `paperclock-v*`, `saintjohn-v*`, `parlo-v*`, and `mypeople-v*` tags. Paper Clock, Parlo, and MyPeople share the reusable [`android-apk.yml`](.github/workflows/android-apk.yml) workflow, which checks debug and unsigned release APKs on pull requests, then signs and publishes the tested release APK on `main`. Release signing uses the existing repository Android signing secrets; release version codes are `1000 + github.run_number` (do not reset the workflow run counter).

For installation and automatic updates on Android/GrapheneOS, see the [Obtainium setup guide](android/OBTAINIUM.md), including one-tap imports for all five Android/Flutter apps.

### MyPeople CLI (Python)

[`cli/mypeople`](cli/mypeople) is an independent uv project, outside pnpm/Turbo.

```bash
cd cli/mypeople
uv sync --locked
uv run --locked mypeople --help
uv run --locked pytest
uv build
```

From the root, use `pnpm mypeople --help` or `pnpm mypeople:check`.
The scoped CI runs synthetic tests and builds Python distributions without personal
credentials. See [migration, configuration, and Android signing safety](docs/mypeople/monorepo.md)
before switching an existing phone installation. Private credentials are loaded
from `~/.mypeople/secrets.ini` or an explicit `MYPEOPLE_ENV_FILE`, never from the checkout.

### macOS

[Fuego](macos/fuego) is an Xcode project and is not a pnpm workspace. It requires Xcode on macOS 15.5 or later.

```bash
pnpm macos:fuego:build
```

[`macos-fuego.yml`](.github/workflows/macos-fuego.yml) runs its unit tests and an unsigned Release build. The manually dispatched [`macos-fuego-release.yml`](.github/workflows/macos-fuego-release.yml) signs, notarizes, and publishes `fuego-v*` releases; installed copies check for Sparkle updates at `downloads.jonaylor.com/fuego/appcast.xml`. Its website is [`apps/fuego`](apps/fuego).

[MyPeople for macOS](macos/mypeople) is a SwiftUI app over the MyPeople CLI's own code. It needs Xcode 16 or later to build and macOS 15 or later to run.

```bash
pnpm macos:mypeople:check
pnpm macos:mypeople:build
```

[`macos-mypeople.yml`](.github/workflows/macos-mypeople.yml) runs its tests, including one against the real Python engine, and an unsigned Release build. It has no release workflow yet.

### Flutter

[Prego](flutter/prego) is an independent Flutter project, not a pnpm workspace.
Install the SDK pinned in `flutter/prego/.flutter-version` and JDK 21 for Android.

```bash
pnpm prego:check
pnpm prego:build
# Or: cd flutter/prego && flutter run
```

The scoped [Prego workflow](.github/workflows/flutter-prego.yml) checks formatting,
analysis, tests, Android debug/release builds, and an unsigned iOS build on pull
requests and `main`. Successful `main` builds publish a signed Android APK and
checksum in `prego-v*` GitHub Releases using the existing repository Android
signing secrets. iOS is compile-checked only; there is no App Store deployment.
Download the latest signed Android APK at [downloads.jonaylor.com/prego.apk](https://downloads.jonaylor.com/prego.apk).
See [Prego's README](flutter/prego/README.md) for signing and release details.

## Quality checks

[Biome](https://biomejs.dev/) provides formatting and linting for the configured JavaScript and TypeScript sources.

```bash
pnpm lint       # Check formatting and lint rules
pnpm lint:fix   # Apply safe Biome fixes
pnpm format     # Format files
```

For a Rust service, run its checks from that service directory:

```bash
cd services/<service>
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and pull-request guidelines.
