# Contributing to Tattle

Thanks for helping. Tattle filters every connection on the Mac it runs on, so correctness
and safety come before features.

## Ground rules

- **Treat everything that crosses XPC as untrusted.** The extension runs as root. Validate
  every input and check the connecting client's code signature before accepting commands.
- **Never block the filter thread.** Verdicts can't wait on disk, the network or the UI.
  Hand work to a queue and decide from memory.
- **Fail safe.** If the app is gone, the extension keeps enforcing existing rules and applies
  the default policy to new flows. Never filter loopback. Never deadlock the network.
- **No telemetry**, no shell-outs and no dynamic code loading.
- **Clean room.** Don't copy code, text, artwork or file formats from other firewalls.
- **Few dependencies.** Add a Swift package only when it clearly earns its place.

## Layout

- `TattleShared/` holds all logic that can be tested without the extension. Put new logic
  here when you can, with tests.
- `FilterExtension/`, `App/` and `tattlectl/` should stay thin adapters over
  `TattleShared`.
- Changing the rule JSON? Bump the version and update [docs/rule-format.md](docs/rule-format.md).

## Before you send a change

```sh
cd macos/tattle
(cd TattleShared && swift test)
(cd TattleShared && swift run -c release tattle-bench)   # if you touched matching
xcodebuild -project Tattle.xcodeproj -scheme Tattle -configuration Debug \
  CODE_SIGNING_ALLOWED=NO build
```

If you touched the extension or the app's install flow, run the relevant parts of
[docs/QA.md](docs/QA.md) on a signed build, including `scripts/integration-test.sh`. Say
which ones you ran in the pull request.

Matcher coverage should stay above 90%:

```sh
cd TattleShared && swift test --enable-code-coverage
xcrun llvm-cov report .build/debug/TattleSharedTests.xctest/Contents/MacOS/TattleSharedTests \
  -instr-profile=.build/debug/codecov/default.profdata \
  -ignore-filename-regex='(\.build/|Tests/|checkouts)'
```

Keep commits small and descriptive, for example `tattle: match rules by CIDR`.

## Signing

Never commit certificates, provisioning profiles or `Config/Local.xcconfig`. See the README
for using your own team ID.
