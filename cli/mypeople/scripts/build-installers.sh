#!/usr/bin/env bash
# Build all three local installers after synthetic regression checks. Never launches
# an app, opens a personal DB, uninstalls a package, or installs on a device.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [NEW_OUTPUT_DIRECTORY]" >&2
  exit 2
fi
if [[ $# -eq 1 ]]; then
  mkdir "$1" # refuse an existing directory rather than overwrite prior installers
  OUT="$(cd "$1" && pwd)"
else
  OUT="$(mktemp -d "${TMPDIR:-/tmp}/mypeople-installers.XXXXXX")"
fi

export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
cd "$ROOT"
pnpm mypeople:check
pnpm macos:mypeople:check
(
  cd android/mypeople
  ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest
)
(cd cli/mypeople && uv build --out-dir "$OUT/cli" && uv export --locked --no-dev --extra bluetooth --no-emit-project --no-hashes --format requirements.txt > "$OUT/cli/constraints.txt")
WHEELS=("$OUT"/cli/*.whl)
[[ ${#WHEELS[@]} -eq 1 ]] || { echo "Expected one CLI wheel" >&2; exit 1; }
WHEEL_URL="$(uv run --locked --project cli/mypeople python -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).as_uri())' "${WHEELS[0]}")"
xcodebuild -project macos/mypeople/MyPeople.xcodeproj -scheme MyPeople \
  -configuration Release -derivedDataPath "$OUT/build" CODE_SIGNING_ALLOWED=NO build

ditto "$OUT/build/Build/Products/Release/MyPeople.app" "$OUT/MyPeople.app"
codesign --force --options runtime --timestamp=none --sign - "$OUT/MyPeople.app"
codesign --verify --strict "$OUT/MyPeople.app"
ditto -c -k --sequesterRsrc --keepParent "$OUT/MyPeople.app" "$OUT/MyPeople-macos.zip"
cp android/mypeople/app/build/outputs/apk/debug/app-debug.apk "$OUT/MyPeople-android.apk"
(
  cd "$OUT"
  shasum -a 256 MyPeople-android.apk MyPeople-macos.zip cli/*.whl > SHA256SUMS
)
cat > "$OUT/INSTALL.txt" <<EOF
MyPeople local installers

CLI (install/update before opening the Mac app):
  uv tool install --reinstall --python 3.13 --constraints '$OUT/cli/constraints.txt' 'mypeople[bluetooth] @ $WHEEL_URL'

Mac:
  Quit an already running MyPeople, then copy MyPeople.app to /Applications.
  This build is signed ad hoc, not notarized. Full Disk Access may need granting again.

Android:
  adb -s YOUR_DEVICE_SERIAL install -r '$OUT/MyPeople-android.apk'
  Update in place only. If signing differs, STOP; do not uninstall or clear app data.
  This is the local debug installer, not a signed public release.

Read docs/mypeople/versioned-graph.md before the first upgraded launch. Existing
state must be backed up before migration. No personal state is included in these
installers. Building them did not install or launch anything.
EOF
printf '\nInstallers: %s\n' "$OUT"
