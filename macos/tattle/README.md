# Tattle

An open-source outbound firewall for macOS. Tattle shows every outbound connection each
app on your Mac makes and lets you allow or deny it with rules that stick to the app's
code-signing identity.

Tattle is an independent implementation. It is not affiliated with any other firewall
product and shares none of their code, artwork or file formats. MIT licensed.

> **Status: early development.** All eight milestones are implemented, build, and pass
> unit tests. Installed behaviour has not been through the full [QA checklist](docs/QA.md)
> yet, so expect rough edges.

## Features

- **Per-app rules** keyed on code-signing identity (signing ID + team), with the
  executable path for unsigned tools. Rules match host, domain and subdomains, IP, CIDR,
  port or port range, and protocol; they can last once, until the app quits, until restart,
  or forever.
- **Alerts** for connections no rule covers, showing the app, its signature status, the
  destination and port. Unanswered alerts fall back to your default policy.
- **Modes**: Ask, Silently allow, Silently deny. Silent decisions land in **Review**.
- **Menu bar panel** with a filter switch, the mode, a live traffic graph, a map of the
  countries connections went to in the last 10 minutes, and the apps active right now.
- **Profiles** that switch automatically by Wi-Fi network or interface (VPN `utun`, dock
  Ethernet).
- **System rules** for Apple services (DNS, network configuration, time, certificates,
  push, updates) in their own visible, editable group.
- **Blocklists** in hosts or domain-list format, refreshed on a schedule, with hit counts.
- **Connection log** with live search and **traffic statistics** per app and host.
- **DNS-over-HTTPS** through a DNS proxy (macOS 15+), which also teaches domain rules the
  names behind IP addresses.
- **`tattlectl`** for scripting: status, rules, import/export, `log tail -f`.
- JSON rule [import/export](docs/rule-format.md). No telemetry.

| Milestone | State |
|---|---|
| 1. Skeleton: targets, entitlements, signing | Done |
| 2. Observe-only connection log | Done |
| 3. Rules, alerts, rules editor | Done |
| 4. Alert / silent modes, network profiles | Done |
| 5. Blocklist subscriptions | Done |
| 6. Traffic statistics | Done |
| 7. DNS over HTTPS | Done (macOS 15+) |
| 8. `tattlectl` command-line tool | Done |

## Requirements

- macOS 14 or later
- Xcode 16 or later (Swift 6)
- To run the filter: a **paid** Apple Developer Program membership (see below)

## Architecture

```
┌──────── Tattle.app (user) ──────────┐   ┌── tattlectl (user/sudo) ────┐
│ SwiftUI menu bar + window           │   │ status, rules, import/      │
│ AlertCenter (answers alerts)        │   │ export, log tail            │
│ NetworkMonitor (Wi-Fi name)         │   └──────────────┬──────────────┘
│ FilterController: install, NEFilter-│                  │
│   Manager, NEDNSProxyManager        │                  │
└──────────────┬──────────────────────┘                  │
               │  NSXPCConnection, both directions checked by code signature:
               │  only this team's app and tattlectl; writes from the CLI need root
┌──────────────▼──── FilterExtension.systemextension (root, sandboxed) ─────┐
│ FilterDataProvider ── handleNewFlow → FilterService.decide (in memory,    │
│   O(log n)); pauses only for a new process's signature check or an alert  │
│ DNSProxyProvider ── DoH resolver → HostnameCache (IP → names)             │
│ FilterService ── RuleIndex · BlocklistSet · alerts · log buffer · timers  │
│ TattleDatabase (GRDB/SQLite, WAL) ── rules, profiles, settings,           │
│   blocklists, connections, traffic; written off the filter path           │
└──────────────┬────────────────────────────────────────────────────────────┘
               │ app, extension and CLI all link
┌──────────────▼──── TattleShared (Swift package) ───────────────────┐
│ Models, matching, policy, blocklist/DNS parsing, storage, XPC,     │
│ the FilterService itself. Tested with `swift test`.                │
└────────────────────────────────────────────────────────────────────┘
```

| Path | What it is |
|---|---|
| `App/` | The SwiftUI app: setup, connections, review, rules, profiles, blocklists, traffic, settings, alerts. |
| `FilterExtension/` | The system extension: content filter, DNS proxy, XPC listener. |
| `tattlectl/` | The command-line tool, embedded in `Tattle.app/Contents/MacOS`. |
| `scripts/integration-test.sh` | End-to-end checks with curl and nc against an installed filter. |
| `TattleShared/` | A Swift package with everything that can be tested on its own. |
| `Config/Signing.xcconfig` | Team ID and bundle ID prefix for every target. |

The extension's bundle ID, app group and XPC Mach service name all derive from
`TATTLE_BUNDLE_PREFIX`. The app reads them from the embedded extension's Info.plist, so the
Swift source never hard-codes them.

### Fail-safe behaviour

- The filter decides from memory. Disk, network and the app are never on the verdict path.
- A new process's signature check and alerts run on other queues while the flow is paused;
  every paused flow is resumed, with the default policy if the app doesn't answer in time
  or more than 64 alerts are waiting.
- Loopback traffic is excluded in the filter settings and again in code.
- If the database can't be opened the extension keeps filtering with defaults in memory.
- If the extension crashes or is disabled, macOS lets traffic through.

### Sandbox

The extension runs in the App Sandbox with one exception: read-only access to the whole
filesystem (`temporary-exception.files.absolute-path.read-only` for `/`). Verifying a
process's code signature means reading its executable, and without the exception every
tool installed in a home folder or Homebrew, and some system daemons, shows up as
"unknown". It can't write anywhere outside its container.

A process whose executable was replaced while it kept running (common after
`brew upgrade`) can't be verified or even located, and shows as "unknown" until it
restarts.

In Ask mode, DNS lookups (port 53) that no rule covers are allowed without an alert,
because macOS attributes them to the app that asked. The connection that follows gets
the alert. Rules about port 53 still apply.

### Performance

`swift run -c release tattle-bench` in `TattleShared` builds an index of 10,000 rules
plus a 100,000-entry blocklist and times 200,000 verdicts. On an Apple-silicon Mac:

| | Time per verdict |
|---|---|
| p50 | 0.79 µs |
| p99 | 1.67 µs |
| p99.9 | 1.79 µs |

Building the index takes 2–5 ms. Lookups are hash-table hits by host, domain suffix,
masked address per prefix length, and signing ID/path, so cost grows with the number of
labels and prefix lengths, not the number of rules.

## Building

```sh
cd macos/tattle
(cd TattleShared && swift test)       # unit tests, no signing needed
(cd TattleShared && swift run -c release tattle-bench)   # verdict benchmark
xcodebuild -project Tattle.xcodeproj -scheme Tattle \
  -configuration Debug CODE_SIGNING_ALLOWED=NO build   # compile check
```

From the monorepo root: `pnpm macos:tattle:check` and `pnpm macos:tattle:build`.

### Free vs. paid Apple Developer account

Content filters need the Network Extension entitlement (`content-filter-provider`) and the
System Extension entitlement. Apple only grants these to **paid** Developer Program teams.

| You have | What works |
|---|---|
| No account / free personal team | Building with `CODE_SIGNING_ALLOWED=NO` and running all unit tests. The app launches, but it can't install the extension. |
| Paid team | Everything. Development-signed builds run on Macs registered to your team. |
| Paid team + Developer ID certificate | Builds you can distribute (after notarization). |

To build with your own team, create `Config/Local.xcconfig` (it's ignored by version control):

```
DEVELOPMENT_TEAM = ABCDE12345
TATTLE_BUNDLE_PREFIX = com.example.Tattle
```

Then open `Tattle.xcodeproj` and build the **Tattle** scheme. Automatic signing registers
the App IDs and the `group.<prefix>` app group for you. From the command line, add
`-allowProvisioningUpdates`.

For Developer ID builds, also set `TATTLE_ENTITLEMENTS_SUFFIX = -DeveloperID`. Those builds
use the `content-filter-provider-systemextension` entitlement value, which Developer ID requires.

### Running during development

macOS only activates system extensions from apps in `/Applications` unless system-extension
developer mode is on. **Developer mode requires System Integrity Protection (SIP) to be
disabled**, so the recommended loop keeps SIP on and copies the build instead:

```sh
xcodebuild -project Tattle.xcodeproj -scheme Tattle -configuration Debug \
  -derivedDataPath build/DerivedData -allowProvisioningUpdates build
ditto build/DerivedData/Build/Products/Debug/Tattle.app /Applications/Tattle.app
open /Applications/Tattle.app
```

Each rebuild needs a higher `CURRENT_PROJECT_VERSION` for macOS to replace the running
extension. On launch, the app notices that the installed extension's build differs from
its own and replaces it without any clicks. The old version stays registered as
"waiting to uninstall on reboot"; that's normal. The XPC service name includes the build
number, so the new extension never collides with the old one's.

On a test Mac where SIP is already off, `systemextensionsctl developer on` lets the extension
activate straight from DerivedData. Turn it back off with `systemextensionsctl developer off`.
Don't disable SIP on a Mac you rely on.

Watch the extension's logs with:

```sh
/usr/bin/log stream --predicate 'subsystem == "dev.jonaylor.Tattle.FilterExtension"' --level debug
```

## Install

1. Open Tattle from `/Applications`. Its eye icon appears in the menu bar.
2. Choose **Open Tattle…** and click **Install**.
3. Approve the extension in **System Settings → General → Login Items & Extensions →
   Network Extensions**.
4. Turn on **Filter network connections** and allow the content filter when macOS asks.
5. Optional: in **Settings**, turn on **Encrypt DNS** (macOS 15+) and allow the DNS proxy.
6. Optional: link the CLI with
   `sudo ln -s /Applications/Tattle.app/Contents/MacOS/tattlectl /usr/local/bin/`.

## Command line

```sh
tattlectl status
tattlectl rules list
sudo tattlectl rules add --deny --signing-id com.example.App --domain tracker.example
sudo tattlectl rules remove 0B7A3C1E-5F0B-4C55-9A57-2C3D1E9F8A10
tattlectl export rules.json && sudo tattlectl import rules.json
tattlectl log tail -n 50 -f --json
```

Reading needs no privileges. Anything that changes the firewall needs `sudo`; the extension
checks the caller's code signature and effective user ID, not just the command.

Only run one content filter at a time while testing. Turn off other firewalls' filters first.

## Uninstall

1. In Tattle, open **Setup**, turn the filter off and click **Uninstall** (this also
   turns off the DNS proxy), or move Tattle.app to the Trash and confirm removing its
   extension.
2. Remove the CLI link if you made one: `sudo rm /usr/local/bin/tattlectl`.
3. Rules and history live in the extension's sandbox container. To remove them too:
   `sudo rm -rf /private/var/root/Library/Containers/dev.jonaylor.Tattle.FilterExtension`
   (macOS may already have removed it). Exported rule files stay where you saved them.

`systemextensionsctl list` should no longer show `dev.jonaylor.Tattle.FilterExtension`,
and System Settings → Network → Filters should no longer list Tattle.

## Privacy

Tattle sends no telemetry. It only makes network requests you configure: blocklist
downloads and, when Encrypt DNS is on, your DNS queries to the resolver you chose. The
connection log and statistics stay on your Mac and expire after the retention you set.
The Wi-Fi name, used for profiles, needs Location access; Tattle never reads or stores
your location.

For the map, the app downloads [DB-IP's IP to Country Lite](https://db-ip.com/db/download/ip-to-country-lite)
table (CC BY 4.0) from `download.db-ip.com` at setup and once a month, and finds
countries on your Mac; addresses are never looked up online. The download is an ordinary
file request that carries nothing about your connections. Its arcs start from your Mac's
region setting, not your location.

### Map data

Country outlines in `App/Geo` come from [Natural Earth](https://www.naturalearthdata.com)
(public domain), converted by `scripts/build-geodata.py`. The IP table isn't in the
repository; `GeoIPTable.swift` converts DB-IP's download.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the manual checklist in [docs/QA.md](docs/QA.md).
