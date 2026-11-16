# Contact photo candidates

## Choosing a photo

- **Android:** tap **Change photo** below the portrait on a person's page. Tap an
  image to preview it, then **Save** to pin it. **Automatic** previews the automatic
  choice; Save returns to that mode without deleting any pictures. **Cancel** leaves
  the preference unchanged. **Add photo** uses Android's system Photo Picker and
  pins the selected image. Everything works offline; the app downloads no images.
- **Mac:** click **Change Photo** below the portrait, or **More → Change Photo…**.
  The native gallery offers the same preview, source labels, Automatic, Cancel and
  Save. **Add Photo…** opens the contact editor's local file chooser workflow.
- Identical images appear as one tile with all their source labels. A selected
  image stays pinned through subsequent imports. Conflicting device choices are
  explained in the chooser; explicitly choosing again resolves the observed
  alternatives. A preference changed since the chooser loaded requires reloading,
  rather than silently resolving an unseen choice.
- Sync the updated CLI, Mac app and APK together. Older peers preserve additive
  graph properties but do not implement the photo-choice policy.

## Authoritative model

The existing versioned graph and blob store remain authoritative. No second image
store, mutable master contact card, clock-based preference reconciliation or new
wire object type is introduced.

A candidate is an `Asset` connected to its original `Person` by `has_asset`:

- `role = profile_photo` (imported), or legacy/manual `contact_photo`;
- `content.blob_hash`: SHA-256 of original bytes;
- `source`, `source_identity`: provider and source-scoped account/contact identity;
- `width`, `height`;
- `first_observed`, `last_observed` (UTC), and `source_updated_at` when truly known.

Importers use `photos.save`, which adds an immutable candidate for new
source/content combinations and shares existing blobs for identical bytes. Repeat
imports reuse the candidate; last-observed updates are coalesced by UTC day.
Downloads and repeated old-export imports are not evidence of a changed avatar:
**last-observed is never used as photo freshness**. Signed CDN links/cookies are
not candidate identities. Supported photos are bounded JPEG/PNG assets; unknown
legacy metadata stays unknown, rather than inventing observation dates.

`Person.photo_choice` is a causal register containing an Asset UUID, or `""` for
Automatic. Choosing for a merged contact explicitly sets the observed registers
of its members. Concurrent alternatives remain visible; wall clocks never pick
which user instruction wins. Existing manual contact-photo assets act as implicit
preferences until an explicit choice (including Automatic) is made.

Automatic selection is the same deterministic policy in Python and Kotlin:

1. Prefer candidates with a minimum side of at least 96 pixels.
2. Within that class, prefer known newer source-update timestamps.
3. Prefer minimum-side resolution, capped at 512 pixels, then stable UUID order.

A valid pin takes precedence over that ranking. While conflicting preferences
await review, a deterministic provisional pin is displayed, not claimed to be a
resolved user decision. Missing/detached preferred candidates keep their register
and show a warning with an automatic fallback. A new explicit choice clears the
unavailable preference. This is a transparent heuristic, not face recognition or
an assertion that the system knows a photo's actual age.

## Compatibility, merges and storage

Existing graph assets are read as candidates without rewriting originals.
Android rebuilds its disposable pre-candidate screen projection once on upgrade;
the Mac invalidates its old view cache. Neither requires a new import or extraction. Legacy
SQL photo rows still migrate through the existing graph cutover. Original assets
replaced by earlier versions are not automatically resurrected from history.

The old `photos` table is a **lossy compatibility projection** (largest per source);
the gallery reads graph associations, never that table. `photos.best`, the app's
published avatar, contact export and Google photo export use the selected
candidate. Imported/large images remain hashed in derived contact cards; unrelated
edits do not inflate a card with an entire original image. Manually uploaded photos
remain compatible with the existing small-card editor.

Original bytes live once in the graph's content-addressed blob store. Files beside
the selected database are disposable, hash-addressed materializations and can be
restored from the graph. The Mac's existing private avatar cache may also contain
redundant UI previews. These caches are not independent authoritative copies.

Merging retains original association edges, candidates and provenance. Undoing a
merge restores those owners. A split moves only the explicitly selected photo
association; a preference referring to a now-detached photo is preserved and
reported as unavailable, never guessed onto another candidate. Returning to
Automatic never retracts photo candidates. Neither operation is permanent erasure;
existing graph history and full encrypted backups retain bytes.

## APIs and verification

- Python: `photo_candidates.view/list_for/save/choose` and compatibility
  `photos.save/best`.
- Mac engine: `contact.photos {uid}` and
  `contact.photo.choose {uid, candidate, observed}`. `candidate = ""` means
  Automatic; `observed` quotes the chooser's preference-operation IDs.
- Android: `GraphStore.photoChoices/choosePhoto` and locked durable Store wrappers.
  Native selection writes the graph locally, not a queued Mac job.
- `android/mypeople/app/src/test/resources/photo-candidates.json` is a shared
  Python/Kotlin policy fixture. Python tests cover idempotence, blob sharing,
  legacy candidates, pins, source freshness, imports, large assets, merges,
  splits, stale/conflicting choices and encrypted cloning. Native tests cover
  persistence and matching projections; Swift also exercises the real Python RPC.
- `PhotoChooserFlowTest` exercises select/save, cancel, Automatic, persistence and
  2× text through the actual Android UI. It requires `myPeopleDisposable=true`,
  emulator hardware and an empty app store with Contacts integration disabled.
  Never run it on a personal installation.
