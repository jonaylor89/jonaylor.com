#!/bin/bash
# Builds a Release copy of MyPeople for this Mac and prints where it is.
#
# macOS ties Full Disk Access to the app's signature. A real signing identity keeps the grant
# across rebuilds. An ad-hoc signature works, but the grant must be given again after each build.
# Choose the identity with MYPEOPLE_SIGN_IDENTITY; "-" means ad-hoc.
set -euo pipefail

cd "$(dirname "$0")/.."
DERIVED=build/DerivedData

xcodebuild -project MyPeople.xcodeproj -scheme MyPeople -configuration Release \
  -derivedDataPath "$DERIVED" CODE_SIGNING_ALLOWED=NO build >/dev/null

APP="$PWD/$DERIVED/Build/Products/Release/MyPeople.app"

IDENTITY="${MYPEOPLE_SIGN_IDENTITY:-}"
if [ -z "$IDENTITY" ]; then
  IDENTITY="$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development[^"]*\)".*/\1/p' | head -n 1)"
fi
if [ -z "$IDENTITY" ]; then
  IDENTITY="-"
  echo "No Apple Development identity found, so signing ad-hoc. Full Disk Access must be granted again after each build." >&2
fi

codesign --force --options runtime --timestamp=none --sign "$IDENTITY" "$APP"
codesign --verify --strict "$APP"

echo "$APP"
