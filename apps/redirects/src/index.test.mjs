import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import worker from "./index.ts";

const originalCaches = Object.getOwnPropertyDescriptor(globalThis, "caches");

beforeEach(() => {
  const responses = new Map();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => ({
        match: async (request) => responses.get(request.url)?.clone(),
        put: async (request, response) => {
          responses.set(request.url, response.clone());
        },
      }),
    },
  });
});

afterEach(() => {
  mock.restoreAll();
  if (originalCaches) {
    Object.defineProperty(globalThis, "caches", originalCaches);
  } else {
    delete globalThis.caches;
  }
});

function advertiseTags(tags) {
  return mock.method(globalThis, "fetch", async () =>
    new Response(tags.map((tag) => `0123456789 refs/tags/${tag}\n`).join("")),
  );
}

function download(path = "/prego.apk") {
  return worker.fetch(new Request(`https://downloads.jonaylor.com${path}`));
}

test("Prego uses its latest numeric build tag and matching APK asset", async () => {
  const github = advertiseTags([
    "parlo-v99.0.0-build.99",
    "prego-v1.0.0-build.2",
    "prego-v1.0.0-build.10",
    "prego-v1.0.0-build.9",
  ]);
  const expected =
    "https://github.com/jonaylor89/jonaylor.com/releases/download/prego-v1.0.0-build.10/Prego-v1.0.0-build.10.apk";
  const response = await download();
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), expected);

  const cached = await download();
  assert.equal(cached.headers.get("location"), expected);
  assert.equal(github.mock.callCount(), 1);
});

test("Prego returns 404 when only other apps have releases", async () => {
  advertiseTags(["parlo-v1.0.0", "saintjohn-v2.0"]);
  const response = await download();
  assert.equal(response.status, 404);
  assert.match(await response.text(), /Prego has no published release yet/);
});

test("MyPeople downloads use only MyPeople releases and preserve the CI asset name", async () => {
  advertiseTags([
    "parlo-v99.0.0-build.99",
    "mypeople-v0.2-build.2",
    "mypeople-v0.2-build.10",
  ]);
  const response = await download("/mypeople.apk");
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/jonaylor89/jonaylor.com/releases/download/mypeople-v0.2-build.10/MyPeople-v0.2-build.10.apk",
  );
});

test("MyPeople returns 404 before its first release, not another app's APK", async () => {
  advertiseTags(["parlo-v99.0.0-build.99", "prego-v1.0.0-build.9"]);
  const response = await download("/mypeople.apk");
  assert.equal(response.status, 404);
  assert.match(await response.text(), /MyPeople has no published release yet/);
});

test("GitHub failure returns a retryable error, not a broken APK redirect", async () => {
  mock.method(globalThis, "fetch", async () => new Response("", { status: 503 }));
  mock.method(console, "error", () => {});
  const response = await download();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "300");
});

test("existing Android downloads retain their app-specific asset naming", async () => {
  advertiseTags(["saintjohn-v1.2", "prego-v99.0.0-build.99"]);
  const response = await download("/saintjohn.apk");
  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://github.com/jonaylor89/jonaylor.com/releases/download/saintjohn-v1.2/app-release.apk",
  );
});

function configFromRedirect(response) {
  assert.equal(response.status, 302);
  const location = response.headers.get("location");
  const prefix = "https://apps.obtainium.imranr.dev/redirect?r=obtainium://app/";
  assert.ok(location.startsWith(prefix));
  return JSON.parse(decodeURIComponent(location.slice(prefix.length)));
}

test("Obtainium links contain separate app IDs and monorepo-safe filters", async () => {
  const fixtures = [
    ["paperclock", "com.paperclock", "Paper Clock v1.0 · build 8 (signed)", "PaperClock-v1.0-build.8.apk"],
    ["saintjohn", "com.jonaylor.saintjohn", "Saint John v1.5", "app-release.apk"],
    ["parlo", "com.parlo.app", "Parlo v0.1.0 · build 16 (signed)", "Parlo-v0.1.0-build.16.apk"],
    ["mypeople", "app.sherloq", "MyPeople v0.2 · build 5 (signed)", "MyPeople-v0.2-build.5.apk"],
    ["prego", "dev.vcuram.prego", "Prego v1.0.0 · build 3", "Prego-v1.0.0-build.3.apk"],
  ];
  for (const [slug, id, title, apk] of fixtures) {
    const config = configFromRedirect(await download(`/obtainium/${slug}`));
    assert.equal(config.id, id);
    assert.equal(config.url, "https://github.com/jonaylor89/jonaylor.com");
    const settings = JSON.parse(config.additionalSettings);
    assert.equal(settings.verifyLatestTag, false);
    assert.equal(settings.fallbackToOlderReleases, true);
    assert.equal(settings.noVersionDetection, true);
    assert.equal(settings.sortMethodChoice, "date");
    const titleFilter = new RegExp(settings.filterReleaseTitlesByRegEx);
    const apkFilter = new RegExp(settings.apkFilterRegEx);
    assert.ok(titleFilter.test(title));
    assert.ok(apkFilter.test(apk));
    assert.equal(apkFilter.test(`${apk}.sha256`), false);
    for (const [, otherId, otherTitle, otherApk] of fixtures) {
      if (otherId === id) continue;
      assert.equal(titleFilter.test(otherTitle), false);
      assert.equal(apkFilter.test(otherApk), false);
    }
    if (slug === "paperclock" || slug === "parlo" || slug === "mypeople") {
      assert.equal(titleFilter.test(title.replace(" (signed)", "")), false);
    }
  }
});

test("bulk Obtainium link downloads JSON rather than using the unsupported apps redirect", async () => {
  const bulk = await download("/obtainium/all");
  assert.equal(bulk.status, 200);
  assert.equal(bulk.headers.get("location"), null);
  assert.match(bulk.headers.get("content-type"), /application\/json/);
  assert.match(bulk.headers.get("content-disposition"), /attachment/);
  const configs = await bulk.json();
  const response = await download("/obtainium.json");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.match(response.headers.get("content-disposition"), /jonaylor-obtainium.json/);
  assert.deepEqual(await response.json(), configs);
  assert.equal(new Set(configs.map((app) => app.id)).size, 5);
});

test("unknown Obtainium app is rejected and other host redirects remain unchanged", async () => {
  assert.equal((await download("/obtainium/unknown")).status, 404);
  const response = await worker.fetch(new Request("https://blog.jonaylor.com/obtainium/prego"));
  assert.equal(response.headers.get("location"), "https://jonaylor.com/blog/obtainium/prego");
});

test("downloads help advertises the stable Prego APK route", async () => {
  const response = await download("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\/prego\.apk/);
});
