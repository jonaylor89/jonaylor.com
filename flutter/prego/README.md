# Prego

A historical novelty pregnancy-test simulator, migrated from the standalone
`prego` checkout (source revision `fc3d3a74`). Results are generated randomly;
this app cannot detect pregnancy and is not medical advice. Do not put liquids
on your phone.

The timer, randomized results, theme toggle, preferences, and original app icons
are retained. The 2019 Flutter scaffolding has been regenerated for modern
Flutter, including null safety, Android embedding v2/AndroidX, and iOS scenes.
The obsolete `dynamic_theme` package is replaced by Flutter's built-in theming.
The original Android ID (`dev.vcuram.prego`) and iOS ID (`com.example.prego`)
are preserved. Minimum OS versions now follow the modern Flutter toolchain
(Android API 24 and iOS 15).

## Develop

Use the exact Flutter SDK in [`.flutter-version`](.flutter-version) (currently
3.47.6 / Dart 3.13), JDK 21, and the Android SDK. For iOS, use a compatible Xcode
installation on macOS. Flutter manages SDK platform/NDK dependencies; accept the
Android SDK licenses first (`flutter doctor --android-licenses`).

From the monorepo root:

```bash
pnpm prego:check
pnpm prego:build
```

Or from this directory:

```bash
flutter pub get --enforce-lockfile
dart format --output=none --set-exit-if-changed lib test
flutter analyze --no-pub
flutter test --no-pub
flutter run
flutter build apk --debug --no-pub
flutter build apk --release --no-pub
flutter build ios --release --no-codesign --no-pub
```

Without signing environment variables, the Android release build is **unsigned**.
The debug APK is installable at `build/app/outputs/flutter-apk/app-debug.apk`.
Release APK output is `build/app/outputs/flutter-apk/app-release.apk`.

Keep `pubspec.lock` and the Gradle wrapper tracked. Do not commit `build/`,
`.dart_tool/`, generated platform files, signing credentials, or local SDK paths.
When updating Flutter, update the version pin, SDK constraints, scaffolding as
needed, and lockfile together, then run both platform builds.

## CI and delivery

[flutter-prego.yml](../../.github/workflows/flutter-prego.yml) runs only for changes
to this project or its workflow on PRs targeting `main` and pushes to `main`.
It can also be run manually.

- Formatting, static analysis, and widget tests run with locked dependencies.
- Linux builds Android debug and unsigned-release APKs, saved as workflow
  artifacts for 14 days. macOS compiles an unsigned iOS release.
- After **both platforms pass**, a `main` push or manual run on `main` signs the
  exact unsigned Android artifact from that run, verifies its signature, and
  publishes an APK plus SHA-256 checksum as a GitHub Release.
- PRs and manual runs on other branches never access signing secrets or publish.
  No version-bump commits are pushed, and tags target the tested commit.
- Releases use `prego-v<pubspec-version>-build.<workflow-run-number>` tags and
  `Prego-v<pubspec-version>-build.<workflow-run-number>.apk` assets. They do not
  replace the monorepo's global latest release.
- Android version codes are the historical `pubspec.yaml` build number plus the
  workflow run number. Keep the base build number nondecreasing and do not reset
  the workflow run counter. Reruns retain the same version/tag.

### Android signing

CI reuses these **existing repository secrets**, also used by Saint John:

| Secret | Purpose |
| --- | --- |
| `KEYSTORE_BASE64` | Base64-encoded Android signing keystore |
| `KEYSTORE_PASSWORD` | Keystore password |
| `KEY_ALIAS` | Signing key alias |
| `KEY_PASSWORD` | Signing key password |

Missing credentials fail release signing rather than silently publishing a
debug-signed APK. The decoded keystore lives in the runner's temporary directory
and is removed after signing. PR build jobs have read-only repository permissions;
only the release job can write releases/tags.

For a locally signed Android release, set `KEYSTORE_FILE` to an absolute keystore
path and export `KEYSTORE_PASSWORD`, `KEY_ALIAS`, and `KEY_PASSWORD`, then run
`flutter build apk --release`. No local signing files are required by CI.

**Existing installs:** a historical Prego installation signed with a different
key cannot be updated with the monorepo signing key. Use the original key if
upgrade compatibility is required; otherwise uninstall the old app first.

### iOS distribution

iOS CI is an unsigned compile check, not a distributable IPA. App Store/TestFlight
delivery needs a registered bundle ID, provisioning profile, signing certificate,
and a separate approved distribution workflow. No developer team or personal
signing identity is committed.
