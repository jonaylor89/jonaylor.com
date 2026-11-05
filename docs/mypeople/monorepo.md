# MyPeople in the monorepo

## Layout and local commands

- `android/mypeople`: independent Gradle project; package ID `app.sherloq`.
- `cli/mypeople`: independent uv project with its own Python pin and lockfile.
- `docs/mypeople`: product, protocol, and operational documentation.
- Cross-language protocol fixtures remain in `android/mypeople/app/src/test/resources`;
  the Python tests read the same files. Keep these fixtures synthetic.

Python examples throughout these docs run from `cli/mypeople`.
From the monorepo root:

```sh
pnpm mypeople --help
pnpm mypeople:check
pnpm android:mypeople:build
cd cli/mypeople
uv sync --locked
uv run --locked pytest
uv build
```

Python is intentionally outside pnpm/Turbo. No root Python workspace or Node
wrapper package is necessary. Python and Android versions are independent;
wire-format compatibility is tested with the shared fixtures.

## Snapshot migration and private state

The import copies tracked working-copy files only, including pending source
changes, without the original Git history. The original MyPeople checkout is left
intact. Do not delete it until the imported project and private state are verified.
Do not copy its `.git`, `.jj`, `.venv`, caches, Android builds, `local.properties`,
reports, or `.env`. History was not audited or imported.

The existing database and private configuration under `~/.mypeople` remain in
place. No database migration is required just because source files moved.

The old source-tree `.env` is no longer automatically loaded. Either move it
manually to `~/.mypeople/secrets.ini` (do not overwrite an existing file), or set
`MYPEOPLE_ENV_FILE` to its absolute private path. Restrict permissions to the
owner (`chmod 600`). Explicit environment variables take precedence.
Pi auth remains read-only at its configured external location.

Never commit OAuth clients/tokens, browser profiles, pairing QR images,
transfer keys, contact/message exports, or personal fixtures.
Encrypted exports still contain private data and do not belong in source control.
Ignore rules and Gitleaks are defense in depth, not proof of absence of personal
data. If a real secret ever enters history, revoke/rotate it; deleting the current
file is insufficient.

For a globally available CLI, install from this directory with
`uv tool install --from ./cli/mypeople mypeople` at the monorepo root.
Reinstall after source updates; continue using uv in the project for development.
Bluetooth extras require macOS.

## CI and releases

Both scoped workflows run on MyPeople Android, CLI, or documentation changes,
so cross-language changes exercise both suites. Neither requires pnpm.
The CLI workflow pins uv, installs the pinned Python, syncs with `--locked`,
runs synthetic pytest tests and the help entry point, and builds wheel/sdist.
Live Docker tests and private-device diagnostics remain opt-in; no personal
credentials are supplied to CI. Optional OSINT/browser suites are not installed
in the base CI job.

[`macos-mypeople.yml`](../../.github/workflows/macos-mypeople.yml) runs on Mac app, CLI,
or documentation changes, because the app depends on the engine's protocol. It runs the
Swift tests, including one against the real Python engine with a throwaway database, and
builds an unsigned Release. The CLI workflow also runs when the fixture it shares with the
Swift tests changes. See the [Mac app's architecture](macos.md).

All three workflows first call `mypeople-security.yml`, which scans a tracked snapshot
of all four MyPeople directories using pinned Gitleaks with redacted output.
It does not scan historical commits or unrelated monorepo projects.

Android uses the shared `android-apk.yml`: JDK 25 for Gradle, JDK 17 for compilation,
SDK platform 37.0, and build tools 36.0.0. It runs unit tests and lint, then
assembles debug and unsigned release APKs. PRs publish workflow artifacts only.
Only the publishing job on main receives the explicitly mapped repository signing
secrets: `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`.
These must already be configured; no local keystore is imported.

Release tags are `mypeople-v<versionName>-build.<run_number>`; assets are
`MyPeople-v<versionName>-build.<run_number>.apk` plus a SHA-256 checksum.
The version code is `1000 + GITHUB_RUN_NUMBER`. Keep the caller workflow and its
run counter stable, and do not reset the counter; ensure the first code exceeds
the code on every existing installation.

Download/update routes:
- `https://downloads.jonaylor.com/mypeople.apk`
- `https://downloads.jonaylor.com/obtainium/mypeople`

These routes require deploying the redirects worker after merging.

## Existing Android installation: signing transition

The former app signed even release builds with a local debug certificate.
The monorepo uses the repository's release certificate. Android will reject an
in-place update across these different certificates, despite the same package ID.

Before uninstalling anything:

1. Reconcile pending contact edits with the Mac, and verify acknowledgments.
2. Follow [contacts backup/recovery](contacts.md) and
   [offline transfer](bluetooth.md); make and verify a recoverable backup.
3. Confirm the new signed APK and a compatible CLI are available.
4. Only then uninstall/reinstall through Obtainium and restore/sync.
5. Verify contacts, edits, and pairing before removing any old backup or checkout.

Do not automate uninstalling this app. Uninstalling destroys its app-private data.
Future releases must preserve the package ID, certificate, and increasing version
code for in-place updates.
