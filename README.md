# jonaylor.com

Personal websites, experiments, and self-hosted services maintained by [Johannes Naylor](https://jonaylor.com).

JavaScript apps live in [`apps`](apps), native Android apps in [`android`](android), native macOS apps in [`macos`](macos), and self-contained Rust services in [`services`](services).

## Getting started

### Prerequisites

- Node.js 22.12 or later
- [pnpm](https://pnpm.io/) 10.32.1 (the version pinned by `packageManager`)
- Rust and Cargo, only when working on a service

```bash
git clone https://github.com/jonaylor89/jonaylor.com.git
cd jonaylor.com
pnpm install
```

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
```

Their GitHub Actions workflows build and publish app-specific releases with `paperclock-v*`, `saintjohn-v*`, and `parlo-v*` tags. Paper Clock and Parlo share the reusable [`android-apk.yml`](.github/workflows/android-apk.yml) workflow, which builds a debug APK on pull requests and publishes it as a GitHub Release on `main`.

### macOS

[Fuego](macos/fuego) is an Xcode project and is not a pnpm workspace. It requires Xcode on macOS 15.5 or later.

```bash
pnpm macos:fuego:build
```

[`macos-fuego.yml`](.github/workflows/macos-fuego.yml) runs its unit tests and an unsigned Release build. The manually dispatched [`macos-fuego-release.yml`](.github/workflows/macos-fuego-release.yml) signs, notarizes, and publishes `fuego-v*` releases; installed copies check for Sparkle updates at `downloads.jonaylor.com/fuego/appcast.xml`. Its website is [`apps/fuego`](apps/fuego).

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
