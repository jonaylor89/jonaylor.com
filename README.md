# jonaylor.com

Personal websites, experiments, and self-hosted services maintained by [Johannes Naylor](https://jonaylor.com).

JavaScript apps live in [`apps`](apps); self-contained Rust services live in [`services`](services).

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
