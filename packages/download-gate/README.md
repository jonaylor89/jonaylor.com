# @jonaylor/download-gate

An email field next to a download button. The button stays disabled until the
email is valid; submitting records the email with hub (`POST /api/downloads`)
and starts the download right away. Hub sends a one-time thank-you email that
invites the person to subscribe to the newsletter.

```astro
---
import DownloadForm from "@jonaylor/download-gate";
---
<DownloadForm app="parlo" href="https://downloads.jonaylor.com/parlo.apk" buttonClass="btn filled">
  Download the APK
</DownloadForm>
```

The button keeps the site's own classes. Style the email field with custom
properties on any ancestor: `--download-form-height`, `--download-form-radius`,
`--download-form-border`, `--download-form-bg`, `--download-form-color` and
`--download-form-width`.

A remembered email (in `localStorage`) is prefilled on later visits. Without
JavaScript the button stays enabled and goes straight to the download. The
site's origin must be in hub's CORS list in `services/hub/src/startup.rs`, and
new app slugs go in `DOWNLOADABLE_APPS` in `services/hub/src/routes/downloads.rs`.

`PUBLIC_DOWNLOADS_API_URL` overrides the hub URL (for example
`http://127.0.0.1:8000` in local development).
