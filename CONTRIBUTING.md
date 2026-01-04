# Contributing to jonaylor.com

Thank you for your interest in contributing! This is a personal website monorepo, but contributions are welcome.

## Getting Started

### Prerequisites

- **Node.js** 18+ (LTS recommended)
- **pnpm** 10.27.0 (managed via `packageManager` in package.json)

### Setup

```bash
# Clone the repository
git clone https://github.com/jonaylor89/jonaylor.com.git
cd jonaylor.com

# Install dependencies
pnpm install
```

## Development Workflow

### Project Structure

This is a monorepo managed with **pnpm workspaces** and **Turbo**:

- `apps/blog/` - Main blog (Astro)
- `apps/linktree/` - Link aggregator page (Astro)
- `apps/www/` - Legacy site (not actively maintained)
- `apps/resume/` - Legacy resume (not actively maintained)
- `apps/gm/` - Legacy game (not actively maintained)

### Commands

Run from the **root directory**:

```bash
# Development
pnpm dev                    # Start all apps in dev mode
pnpm --filter blog dev      # Start only the blog
pnpm --filter linktree dev  # Start only the linktree

# Building
pnpm build                  # Build all apps
pnpm --filter blog build    # Build only the blog

# Linting & Formatting
pnpm lint                   # Check all apps for lint issues
pnpm lint:fix               # Auto-fix all fixable issues
pnpm format                 # Format all code

# Per-app linting
pnpm --filter blog lint     # Lint only the blog
pnpm --filter blog lint:fix # Auto-fix blog issues

# Testing
pnpm --filter blog test     # Run blog tests (Playwright)
pnpm --filter linktree test # Run linktree tests (Playwright)
```

## Code Quality

### Linting & Formatting

This project uses **[Biome](https://biomejs.dev/)** instead of ESLint/Prettier for **10-100x faster** linting and formatting.

**Before committing, always run:**

```bash
pnpm lint        # Check for issues
pnpm lint:fix    # Auto-fix issues
pnpm format      # Format code
```

### Configuration

- **Biome config**: `biome.json` (root-level, unified config)
- **Formatting style**:
  - Tabs for indentation (width: 2)
  - Double quotes for strings
  - Semicolons always
  - 100 character line width
  - ES5 trailing commas

### Rules

- **Linting**: Strict a11y, correctness, and suspicious code checks
- **Test files**: Non-null assertions and explicit `any` are allowed
- **Astro files**: Unused variables/imports are allowed (framework requirements)
- **CSS**: `!important` allowed (for overriding third-party styles)

## Making Changes

### Branch Strategy

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feature/my-feature
   ```

2. Make your changes following the existing code style

3. Ensure all checks pass:
   ```bash
   pnpm lint
   pnpm build
   ```

4. Commit your changes:
   ```bash
   git add .
   git commit -m "feat: add awesome feature"
   ```

5. Push and create a pull request

### Commit Messages

Use conventional commits format:

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Test additions or fixes
- `chore:` - Maintenance tasks

Examples:
```
feat(blog): add dark mode toggle
fix(linktree): correct card hover animation
docs: update contributing guide
```

## Testing

### Unit/Integration Tests

Currently, this project uses **Playwright** for E2E testing:

```bash
# Run all tests
pnpm --filter blog test
pnpm --filter linktree test

# Run tests in headed mode (see browser)
pnpm --filter blog test --headed
```

### Manual Testing

For visual changes:

1. Start the dev server: `pnpm --filter blog dev`
2. Open http://localhost:4321 (blog) or http://localhost:4322 (linktree)
3. Test in multiple browsers and devices
4. Verify dark mode support
5. Check responsive design

## Continuous Integration

All pull requests automatically run the following checks via GitHub Actions:

1. **Biome CI** - Lints and formats all code
2. **Build** - Ensures blog and linktree apps build successfully
3. **Tests** - Runs Playwright E2E tests (if configured)

You can run these checks locally before pushing:

```bash
pnpm biome ci .        # Same check that runs in CI
pnpm lint              # Check for lint issues
pnpm build             # Build all apps
```

## Pull Request Guidelines

### Before Submitting

- [ ] Lint passes: `pnpm lint`
- [ ] Build succeeds: `pnpm build`
- [ ] Tests pass (if applicable): `pnpm --filter <app> test`
- [ ] Code follows existing patterns and conventions
- [ ] Commit messages follow conventional commits
- [ ] Changes are documented (if needed)
- [ ] CI checks pass (automatically run on PR)

### PR Description Template

```markdown
## Description
Brief description of what this PR does

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Tested locally
- [ ] Linting passes
- [ ] Build succeeds
- [ ] Tests pass (if applicable)

## Screenshots (if applicable)
```

## Need Help?

- Check existing issues: https://github.com/jonaylor89/jonaylor.com/issues
- Review the code and follow existing patterns
- Ask questions in your PR if uncertain

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
