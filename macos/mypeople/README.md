# MyPeople for macOS

A native Mac app for [MyPeople](../../cli/mypeople/README.md). Like the
[Android app](../../android/mypeople/README.md), it's for reading and writing your contacts: their
details, notes and facts, plus reviewing duplicates, conflicts and suggested profiles. It also runs
the Mac's side of the QR and Bluetooth exchange with your phone.

Importing messages, reading them for facts, finding profiles, collecting photos and Google sync stay
in the [CLI](../../cli/mypeople/README.md). Their results show up here on each contact.

It works on the same database as the CLI, `~/.mypeople/mypeople.db`, and contains no logic that can
change your data: every edit goes through the CLI's own code, which the app runs as a background
process. [Why it's built this way](../../docs/mypeople/macos.md).

Requires macOS 15 or later, and the CLI.

## Install

There is no signed download yet, so build it yourself with Xcode 16 or later:

```bash
uv tool install --from './cli/mypeople[bluetooth]' mypeople
macos/mypeople/scripts/build-local.sh
```

The script prints the app's location. Move it to Applications and open it.

The app looks for the CLI in the path chosen in Settings, `$MYPEOPLE_BIN`, `~/.local/bin`, Homebrew,
and your shell's `PATH`, then falls back to this repository through uv. Update the CLI when you
update the app, because the app refuses a CLI whose protocol doesn't match and says how to fix it.

## Permissions

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
  path/to/MyPeople.app/Contents/MacOS/MyPeople
```

CI runs [`macos-mypeople.yml`](../../.github/workflows/macos-mypeople.yml) on changes to the app, the
CLI, or MyPeople's docs. There is no release pipeline yet.
