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

test("downloads help advertises the stable Prego APK route", async () => {
  const response = await download("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\/prego\.apk/);
});
