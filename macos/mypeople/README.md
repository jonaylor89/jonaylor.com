# MyPeople for macOS

A native Mac app for [MyPeople](../../cli/mypeople/README.md). It does what the
[Android app](../../android/mypeople/README.md) does, plus what only the CLI can: imports, reading
messages, finding profiles, photos, Google sync, and running the sync server.

It works on the same database as the CLI, `~/.mypeople/mypeople.db`, and contains no logic that can
change your data: every edit goes through the CLI's own code, which the app runs as a background
process. [Why it's built this way](../../docs/mypeople/macos.md).

Requires macOS 15 or later, and the CLI.

## Install

There is no signed download yet, so build it yourself with Xcode 16 or later:

```bash
uv tool install --from './cli/mypeople[bluetooth,browser,osint]' mypeople
macos/mypeople/scripts/build-local.sh
```

The script prints the app's location. Move it to Applications and open it.

The app looks for the CLI in the path chosen in Settings, `$MYPEOPLE_BIN`, `~/.local/bin`, Homebrew,
and your shell's `PATH`, then falls back to this repository through uv. Update the CLI when you
update the app, because the app refuses a CLI whose protocol doesn't match and says how to fix it.

## Permissions

- **Full Disk Access** is needed to import from Messages and to read other apps' message stores.
  Grant it to MyPeople, not your terminal. The Import screen links to the right pane. The grant is
  tied to the app's signature, so `build-local.sh` uses your Apple Development identity if you have
  one. With an ad-hoc signature, you have to grant it again after each build.
- **Bluetooth** is requested when you first exchange data with your phone.

## Development

Open `MyPeople.xcodeproj` in Xcode. Screen code is in `MyPeople`. Everything that can be tested
without a window is in the `MyPeopleKit` package. From the repository root:

```bash
pnpm macos:mypeople:check   # Swift tests, including one against the real Python engine (needs uv)
pnpm macos:mypeople:build
pnpm mypeople:check         # after changing the engine
```

To try the app without touching your real data, point everything at a throwaway folder:

```bash
mkdir -p /tmp/mypeople-demo
env HOME=/tmp/mypeople-demo MYPEOPLE_DB=/tmp/mypeople-demo/mypeople.db \
  MYPEOPLE_ENV_FILE=/dev/null MYPEOPLE_PI_AUTH=/dev/null \
  MYPEOPLE_SYNC_CONFIG=/tmp/mypeople-demo/sync.json \
  path/to/MyPeople.app/Contents/MacOS/MyPeople
```

CI runs [`macos-mypeople.yml`](../../.github/workflows/macos-mypeople.yml) on changes to the app, the
CLI, or MyPeople's docs. There is no release pipeline yet.
