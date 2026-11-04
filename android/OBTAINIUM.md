# Install and update with Obtainium

Install [Obtainium](https://obtainium.imranr.dev/) on your Android device, then open these links on that device:

| App | Add to Obtainium | Package ID |
| --- | --- | --- |
| Paper Clock | [Add Paper Clock](https://downloads.jonaylor.com/obtainium/paperclock) | `com.paperclock` |
| Saint John | [Add Saint John](https://downloads.jonaylor.com/obtainium/saintjohn) | `com.jonaylor.saintjohn` |
| Parlo | [Add Parlo](https://downloads.jonaylor.com/obtainium/parlo) | `com.parlo.app` |
| Prego | [Add Prego](https://downloads.jonaylor.com/obtainium/prego) | `dev.vcuram.prego` |

To add all four, download [the bulk import file](https://downloads.jonaylor.com/obtainium/all) (also available at [/obtainium.json](https://downloads.jonaylor.com/obtainium.json)) in your phone's browser, then select the downloaded file from Obtainium's Import/Export screen. Individual app links open Obtainium's official redirect page and ask for confirmation before adding a config. The external redirect page does not support bulk imports. None of these links install APKs without your approval. Do not paste the setup links into Obtainium's Source URL field.

## First installation and automatic updates

1. Confirm the import, check for updates, and install each app **through Obtainium**.
2. When Android asks, allow Obtainium to install unknown apps. Allow notifications so you can see update results or requests for confirmation.
3. In Obtainium settings, enable background update checks and automatic installation of updates. Leave each app eligible for background updates.
4. Allow network/background activity for Obtainium. Start with normal battery settings; if checks are delayed, allow unrestricted battery use for Obtainium.

GrapheneOS does not need Google Play, root, or Shizuku for this. Silent updates require Android 12+, a sufficiently recent target SDK, and Obtainium to be the installer of the installed app. Android may still request confirmation; background installations are best-effort. Use the same Android user/profile for Obtainium and the apps it manages.

If you previously installed a signed APK manually, try reinstalling/updating it through Obtainium to establish it as the installer. Do not uninstall an app with important data unless you have backed up or exported that data.

## One-time migration: Paper Clock and Parlo

Historical releases of these two apps were debug-signed. The Obtainium configs deliberately match only release titles ending in `(signed)`, so they cannot install an older debug APK by mistake. Until the first new signed release is published, these two entries will report no matching release.

After the new release workflow is merged to `main`, its successful builds publish signed APKs. Switching from an existing debug build to the release-signing certificate requires a one-time uninstall/reinstall. **Uninstalling erases local app data:** export/back up anything important first. Future releases retain the package ID and signing certificate and increase the version code, allowing in-place updates.

Prego and Saint John already use release signing and do not need this debug-to-release migration. Parlo's separate `.dev` build is not tracked by these configs.

## How tracking works

All four configs use the same source repository with different Android package IDs, release-title filters, and APK filename filters. They disable the repository-wide “Verify Latest Tag” setting, allow searching older releases, and sort by release date. This prevents a release of another monorepo app from hiding the desired app or being installed accidentally.

Version detection from Android's human-readable version name is disabled: our app-prefixed release tags also contain CI build numbers, whereas the APK version names may stay unchanged between builds. Obtainium instead tracks the selected release tag; Android still enforces signing identity and version-code rules. Avoid updating these apps through a second installer, which can make Obtainium's tracked state inaccurate.

The download worker defines the configs in `apps/redirects/src/index.ts`. Changes to app IDs, release titles, or APK filenames must also update those configs and their tests. The GitHub source searches the most recent 100 releases; if an app eventually falls outside that window, republish a current build or move distribution to a dedicated release repository.

## Release maintenance

Paper Clock and Parlo build without signing credentials in the build job. Only the publishing job on `main` receives the existing `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`, and `KEY_PASSWORD` secrets. It signs the tested release APK, verifies its signature, and publishes an APK and SHA-256 checksum. Never replace the signing key casually: existing installs depend on that certificate.

The two caller workflows pass the signing secrets to the reusable workflow. Pull requests retain downloadable debug APK artifacts but never publish debug releases. Manual workflow dispatch on `main` can publish a fresh signed build if needed.

References: [Obtainium import links](https://wiki.obtainium.imranr.dev/deep_links/) · [background update requirements](https://wiki.obtainium.imranr.dev/app_tracking/) · [source filters](https://wiki.obtainium.imranr.dev/sources/).
