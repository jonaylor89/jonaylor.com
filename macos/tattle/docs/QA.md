# Manual QA checklist

Run these on a development-signed build installed in `/Applications` (see the README). Only
one content filter should be active: turn off other firewalls' filters before you start and
back on afterwards.

Keep a terminal open with the extension's logs:

```sh
/usr/bin/log stream --predicate 'subsystem == "dev.jonaylor.Tattle.FilterExtension"' --level debug
```

## Recovery (read first)

If networking breaks while testing:

1. **System Settings → Network → Filters** (or **VPN & Filters**): select Tattle and
   disable or remove it.
2. Or quit Tattle and move it to the Trash, then approve removing the extension.
3. Last resort: restart. The filter stays installed but you can disable it from System
   Settings before opening any app.

## Milestone 1: skeleton

- [ ] The app launches with no Dock icon. The eye appears in the menu bar (a slashed eye in Silently deny mode).
- [ ] **Open Tattle…** opens the window. Status reads "Not installed" on a clean Mac.
- [ ] **Install** asks for approval. After approving in System Settings, status reads
      "Installed". `systemextensionsctl list` shows `dev.jonaylor.Tattle.FilterExtension`
      as `[activated enabled]`.
- [ ] Turning on **Filter network connections** shows the macOS content-filter prompt.
      After allowing it, the filter appears in System Settings → Network → Filters.
- [ ] With the filter on: web browsing, `curl -sI https://example.com`, and
      `python3 -m http.server 8000 & curl -s localhost:8000 >/dev/null` all work.
- [ ] The log shows "Filter started".
- [ ] Turning the filter off removes it from active filters. Networking still works.
- [ ] **Uninstall** removes the extension (`systemextensionsctl list` no longer lists it).
- [ ] Relaunching the app after a reboot shows the correct status.

## Automated end-to-end checks

With the filter installed and on (mode Ask or Silently allow):

```sh
sudo -v && scripts/integration-test.sh /Applications/Tattle.app
```

It adds temporary rules for `/usr/bin/curl` and `/usr/bin/nc`, checks that allowed and
denied connections behave and are logged with the right verdict, checks that loopback
isn't filtered even with a deny rule for 127.0.0.0/8, and removes its rules on exit.

## Milestone 2: connection log

- [ ] **Connections** fills in as you browse: app icon and name, destination (host name
      where known, otherwise IP), port, verdict, bytes.
- [ ] Search narrows by app name, host or address and clears back to the live list.
- [ ] New connections appear within about a second while the window is open.
- [ ] `tattlectl log tail -f` prints the same connections.
- [ ] Quitting the app doesn't stop logging; reopening shows connections made meanwhile.

## Milestone 3: rules and alerts

- [ ] In Ask mode, `curl https://example.net` from Terminal shows an alert naming curl,
      "Signed by Apple", example.net, port 443. Curl waits.
- [ ] **Allow / Only this time**: curl succeeds; running it again asks again.
- [ ] **Deny / Forever**: curl fails immediately; a rule appears under **Your rules**.
- [ ] **Allow / Until curl quits** with **Any host**: other hosts work for that run only.
- [ ] **Until restart** rules disappear after a reboot.
- [ ] Ignoring an alert applies the default policy after the timeout, the panel moves on,
      and the connection appears in **Review**.
- [ ] Many simultaneous unknown connections (e.g. `for i in $(seq 80); do curl -s
      https://example.net/$i & done`) never hang networking; the overflow uses the
      default policy.
- [ ] Quitting the app while an alert is open resolves it with the default policy.
- [ ] The **System** group lists the Apple service rules; disabling `mDNSResponder` in Ask
      mode produces DNS alerts (re-enable it afterwards).
- [ ] Editing a rule (host → domain, port range, protocol) takes effect on the next
      connection. Invalid input (bad CIDR, port 70000) is refused with a message.
- [ ] Export, delete a rule, import: the rule is back. Import of a non-Tattle JSON file
      is refused with a message.
- [ ] An unsigned binary (`swiftc -o /tmp/t t.swift` making a URL request) shows
      "Not signed" in the alert and its rule matches by path.

## Milestone 4: modes and profiles

- [ ] Menu bar **Mode** switches between Ask, Silently allow and Silently deny; the icon
      changes for Silently deny.
- [ ] Silently deny: unknown connections fail without alerts and show up in **Review**.
      **Always Allow** there creates a rule and removes the item.
- [ ] Create a profile with the current Wi-Fi name. macOS asks for Location access once.
      With automatic switching on it becomes active; a rule limited to it applies only
      while it's active.
- [ ] Connect a VPN; a profile with interface `utunN` activates and deactivates with it.
- [ ] Deleting a profile deletes its rules.

## Milestone 5: blocklists

- [ ] Subscribe to a small hosts-format list over HTTPS. Entry count and "updated" fill in
      after **Refresh**.
- [ ] A listed domain is denied (reason "blocklist"), and the hit count increases.
- [ ] An allow rule for that domain overrides the list.
- [ ] An `http://` URL is refused. A URL that returns 404 shows the error under the list.

## Milestone 6: traffic statistics

- [ ] **Traffic** shows sent/received bars for the last hour/day/week/month.
- [ ] Downloading a large file (`curl -o /dev/null https://speed.cloudflare.com/__down?bytes=50000000`)
      shows up under curl and that host within about 15 seconds.
- [ ] Clicking an app filters the chart and host list to it.
- [ ] Lowering retention and waiting an hour (or restarting the extension) prunes old data.
      **Erase Connection History and Statistics** empties both.

## Milestone 7: DNS-over-HTTPS (macOS 15+)

- [ ] **Settings → Encrypt DNS** asks to allow the DNS proxy; Setup shows it running.
- [ ] `dig example.com` still resolves. `sudo tcpdump -n port 53` shows no plain DNS
      leaving the Mac (except with fallback, when the resolver is unreachable).
- [ ] Domain rules match connections made to raw IPs that were looked up beforehand.
- [ ] Setting an unreachable resolver with fallback on keeps DNS working; with fallback
      off lookups fail (SERVFAIL) until it's fixed.
- [ ] Turning Encrypt DNS off restores the network's DNS.

## Milestone 8: tattlectl

- [ ] `tattlectl status`, `rules list`, `export`, `log tail -n 5 --json` work without sudo.
- [ ] `tattlectl rules add --deny --host x.example` without sudo fails with
      "Run it with sudo"; with sudo it succeeds and the app shows the rule.
- [ ] A copy of tattlectl re-signed ad hoc (`codesign -f -s - /tmp/ctl`) is refused.
- [ ] With the extension off, commands fail within a few seconds with a clear message.
