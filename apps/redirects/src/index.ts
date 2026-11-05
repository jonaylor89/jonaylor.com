const REDIRECTS: Record<string, string> = {
	"blog.jonaylor.com": "https://jonaylor.com/blog",
	"bio.jonaylor.com": "https://jonaylor.com/links",
	"gm.jonaylor.com": "https://jonaylor.com/gm",
	"resume.jonaylor.com": "https://jonaylor.com/resume",
	"linktree.jonaylor.com": "https://jonaylor.com/links",
	"jonaylor.xyz": "https://jonaylor.com",
	"www.jonaylor.xyz": "https://jonaylor.com",
};

const GITHUB_RELEASE_DOWNLOADS = "https://github.com/jonaylor89/jonaylor.com/releases/download";
// Git's ref advertisement isn't subject to the REST API's 60 requests/hour limit for
// unauthenticated callers, which Cloudflare's shared egress IPs regularly hit.
const GIT_REFS_URL = "https://github.com/jonaylor89/jonaylor.com.git/info/refs?service=git-upload-pack";
const RELEASE_CACHE_SECONDS = 600;
const RELEASE_CACHE_NAME = "github-release-cache";

type Install = {
	name: string;
	tagPrefix: string;
	// Release asset file name, which each release workflow derives from its tag.
	assetName: (tag: string) => string;
};

const INSTALLS: Record<string, Install> = {
	"/paperclock.apk": {
		name: "Paper Clock",
		tagPrefix: "paperclock-v",
		assetName: (tag) => `PaperClock-v${tag.slice("paperclock-v".length)}.apk`,
	},
	"/saintjohn.apk": {
		name: "Saint John",
		tagPrefix: "saintjohn-v",
		assetName: () => "app-release.apk",
	},
	"/parlo.apk": {
		name: "Parlo",
		tagPrefix: "parlo-v",
		assetName: (tag) => `Parlo-v${tag.slice("parlo-v".length)}.apk`,
	},
	"/mypeople.apk": {
		name: "MyPeople",
		tagPrefix: "mypeople-v",
		assetName: (tag) => `MyPeople-v${tag.slice("mypeople-v".length)}.apk`,
	},
	"/prego.apk": {
		name: "Prego",
		tagPrefix: "prego-v",
		assetName: (tag) => `Prego-v${tag.slice("prego-v".length)}.apk`,
	},
	"/fuego.dmg": {
		name: "Fuego",
		tagPrefix: "fuego-v",
		assetName: () => "Fuego.dmg",
	},
	// Fuego's Sparkle feed (SPARKLE_FEED_URL); installed apps check it for updates.
	"/fuego/appcast.xml": {
		name: "Fuego",
		tagPrefix: "fuego-v",
		assetName: () => "appcast.xml",
	},
};

// additionalSettings is a JSON string in Obtainium's import/share format.
// Ignore Android version-name detection: our release tags contain app prefixes and
// CI build numbers not present in the APK's human-readable versionName.
const OBTAINIUM_APPS = [
	{ slug: "paperclock", id: "com.paperclock", name: "Paper Clock", apk: "^PaperClock-.*\\.apk$", signedOnly: true },
	{ slug: "saintjohn", id: "com.jonaylor.saintjohn", name: "Saint John", apk: "^app-release\\.apk$", signedOnly: false },
	{ slug: "parlo", id: "com.parlo.app", name: "Parlo", apk: "^Parlo-.*\\.apk$", signedOnly: true },
	{ slug: "mypeople", id: "app.sherloq", name: "MyPeople", apk: "^MyPeople-.*\\.apk$", signedOnly: true },
	{ slug: "prego", id: "dev.vcuram.prego", name: "Prego", apk: "^Prego-.*\\.apk$", signedOnly: false },
].map(({ slug, id, name, apk, signedOnly }) => ({
	slug,
	config: {
		id,
		url: "https://github.com/jonaylor89/jonaylor.com",
		author: "jonaylor89",
		name,
		additionalSettings: JSON.stringify({
			filterReleaseTitlesByRegEx: `^${name} v${signedOnly ? ".* \\(signed\\)$" : ""}`,
			apkFilterRegEx: apk,
			verifyLatestTag: false,
			fallbackToOlderReleases: true,
			sortMethodChoice: "date",
			noVersionDetection: true,
		}),
	},
}));

function obtainiumResponse(path: string): Response | null {
	// The external redirect service accepts app/add, but not Obtainium's apps action.
	// Serve a file for bulk imports instead of sending users to an invalid redirect.
	if (path === "/obtainium.json" || path === "/obtainium/all") {
		return new Response(JSON.stringify(OBTAINIUM_APPS.map(({ config }) => config)), {
			headers: {
				"Content-Type": "application/json; charset=utf-8",
				"Content-Disposition": 'attachment; filename="jonaylor-obtainium.json"',
			},
		});
	}
	if (!path.startsWith("/obtainium/")) return null;
	const slug = path.slice("/obtainium/".length);
	const app = OBTAINIUM_APPS.find((app) => app.slug === slug);
	if (!app) return new Response("Unknown app", { status: 404 });
	const deepLink = `obtainium://app/${encodeURIComponent(JSON.stringify(app.config))}`;
	return Response.redirect(`https://apps.obtainium.imranr.dev/redirect?r=${deepLink}`, 302);
}

type ReleaseAsset = {
	name: string;
	downloadUrl: string;
};

function compareVersions(a: string, b: string): number {
	const left = a.match(/\d+/g)?.map(Number) ?? [];
	const right = b.match(/\d+/g)?.map(Number) ?? [];
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

async function findLatestTag(tagPrefix: string): Promise<string | undefined> {
	const response = await fetch(GIT_REFS_URL, {
		headers: { "User-Agent": "jonaylor-downloads-worker" },
	});
	if (!response.ok) throw new Error(`GitHub ref advertisement returned ${response.status}`);

	const refs = await response.text();
	const tags = [...refs.matchAll(/refs\/tags\/([^\s^]+)/g)]
		.map((match) => match[1])
		.filter((tag) => tag.startsWith(tagPrefix));
	return tags.sort((a, b) =>
		compareVersions(b.slice(tagPrefix.length), a.slice(tagPrefix.length)),
	)[0];
}

async function findLatestAsset(install: Install): Promise<ReleaseAsset | null> {
	const tag = await findLatestTag(install.tagPrefix);
	if (!tag) return null;

	const name = install.assetName(tag);
	return { name, downloadUrl: `${GITHUB_RELEASE_DOWNLOADS}/${tag}/${name}` };
}

async function getLatestAsset(path: string, install: Install): Promise<ReleaseAsset | null> {
	const cache = await caches.open(RELEASE_CACHE_NAME);
	const cacheKey = new Request(`https://downloads.jonaylor.com/__release-cache${path}`);
	const cached = await cache.match(cacheKey);
	if (cached) return (await cached.json()) as ReleaseAsset;

	const latest = await findLatestAsset(install);
	if (!latest) return null;

	await cache.put(
		cacheKey,
		new Response(JSON.stringify(latest), {
			headers: { "Cache-Control": `public, max-age=${RELEASE_CACHE_SECONDS}` },
		}),
	);
	return latest;
}

function downloadHelp(): Response {
	return new Response(
		"Use /paperclock.apk, /saintjohn.apk, /parlo.apk, /prego.apk, or /mypeople.apk to download the latest Android release, or /fuego.dmg for Fuego for macOS. Use /obtainium/paperclock, /obtainium/saintjohn, /obtainium/parlo, /obtainium/prego, /obtainium/mypeople, to add individual apps to Obtainium; /obtainium/all and /obtainium.json download the bulk import file.",
		{
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		},
	);
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.hostname === "downloads.jonaylor.com") {
			const obtainium = obtainiumResponse(url.pathname);
			if (obtainium) return obtainium;
		}
		const install: Install | undefined = INSTALLS[url.pathname];

		if (install) {
			try {
				const asset = await getLatestAsset(url.pathname, install);
				if (!asset) return new Response(`${install.name} has no published release yet.`, { status: 404 });

				return Response.redirect(asset.downloadUrl, 302);
			} catch (error) {
				console.error("Unable to find the latest release", error);
				return new Response("The latest download is temporarily unavailable. Please try again.", {
					status: 503,
					headers: { "Retry-After": "300" },
				});
			}
		}

		if (url.hostname === "downloads.jonaylor.com") return downloadHelp();

		const target = REDIRECTS[url.hostname];
		if (target) {
			const path = url.pathname === "/" ? "" : url.pathname;
			return Response.redirect(`${target}${path}${url.search}`, 301);
		}

		return new Response("Not Found", { status: 404 });
	},
};
