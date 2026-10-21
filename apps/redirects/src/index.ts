const REDIRECTS: Record<string, string> = {
	"blog.jonaylor.com": "https://jonaylor.com/blog",
	"bio.jonaylor.com": "https://jonaylor.com/links",
	"gm.jonaylor.com": "https://jonaylor.com/gm",
	"resume.jonaylor.com": "https://jonaylor.com/resume",
	"linktree.jonaylor.com": "https://jonaylor.com/links",
	"jonaylor.xyz": "https://jonaylor.com",
	"www.jonaylor.xyz": "https://jonaylor.com",
};

const GITHUB_RELEASES_API = "https://api.github.com/repos/jonaylor89/jonaylor.com/releases?per_page=100";
const GITHUB_RELEASE_DOWNLOADS = "https://github.com/jonaylor89/jonaylor.com/releases/download";
// Git's ref advertisement isn't subject to the REST API's 60 requests/hour limit for
// unauthenticated callers, which Cloudflare's shared egress IPs regularly hit.
const GIT_REFS_URL = "https://github.com/jonaylor89/jonaylor.com.git/info/refs?service=git-upload-pack";
// Android apps publish a release on every build, so an app's latest can be past the first page.
const MAX_RELEASE_PAGES = 5;
const RELEASE_CACHE_SECONDS = 600;
const RELEASE_CACHE_NAME = "github-release-cache";

type Install =
	| { name: string; tagPrefix: string; isAsset: (name: string) => boolean }
	// Assets with the same name in every release resolve from tags alone, without the API.
	| { name: string; tagPrefix: string; assetName: string };

const INSTALLS: Record<string, Install> = {
	"/paperclock.apk": {
		name: "Paper Clock",
		tagPrefix: "paperclock-v",
		isAsset: (name: string) => name.endsWith(".apk"),
	},
	"/saintjohn.apk": {
		name: "Saint John",
		tagPrefix: "saintjohn-v",
		isAsset: (name: string) => name.endsWith(".apk"),
	},
	"/parlo.apk": {
		name: "Parlo",
		tagPrefix: "parlo-v",
		isAsset: (name: string) => name.endsWith(".apk"),
	},
	"/fuego.dmg": {
		name: "Fuego",
		tagPrefix: "fuego-v",
		assetName: "Fuego.dmg",
	},
	// Fuego's Sparkle feed (SPARKLE_FEED_URL); installed apps check it for updates.
	"/fuego/appcast.xml": {
		name: "Fuego",
		tagPrefix: "fuego-v",
		assetName: "appcast.xml",
	},
};

type GitHubRelease = {
	draft: boolean;
	prerelease: boolean;
	tag_name: string;
	assets: Array<{
		name: string;
		browser_download_url: string;
	}>;
};

type ReleaseAsset = {
	name: string;
	downloadUrl: string;
};

async function findLatestRelease(tagPrefix: string): Promise<GitHubRelease | undefined> {
	for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
		const response = await fetch(`${GITHUB_RELEASES_API}&page=${page}`, {
			headers: {
				Accept: "application/vnd.github+json",
				"User-Agent": "jonaylor-downloads-worker",
			},
		});
		if (!response.ok) throw new Error(`GitHub Releases API returned ${response.status}`);

		const releases = (await response.json()) as GitHubRelease[];
		const release = releases.find(
			(candidate) =>
				!candidate.draft && !candidate.prerelease && candidate.tag_name.startsWith(tagPrefix),
		);
		if (release || releases.length < 100) return release;
	}
	return undefined;
}

function compareVersions(a: string, b: string): number {
	const left = a.match(/\d+/g)?.map(Number) ?? [];
	const right = b.match(/\d+/g)?.map(Number) ?? [];
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const difference = (left[i] ?? 0) - (right[i] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

// Tags only exist once a release is published, since the release workflows publish drafts last.
async function findLatestTag(tagPrefix: string): Promise<string | undefined> {
	const response = await fetch(GIT_REFS_URL, {
		headers: { "User-Agent": "jonaylor-downloads-worker" },
	});
	if (!response.ok) throw new Error(`GitHub ref advertisement returned ${response.status}`);

	const refs = await response.text();
	const tags = [...refs.matchAll(/refs\/tags\/([^\s^]+)/g)]
		.map((match) => match[1])
		.filter((tag) => tag.startsWith(tagPrefix));
	return tags.sort((a, b) => compareVersions(b.slice(tagPrefix.length), a.slice(tagPrefix.length)))[0];
}

async function findLatestAsset(install: Install): Promise<ReleaseAsset | null> {
	if ("assetName" in install) {
		const tag = await findLatestTag(install.tagPrefix);
		if (!tag) return null;
		return { name: install.assetName, downloadUrl: `${GITHUB_RELEASE_DOWNLOADS}/${tag}/${install.assetName}` };
	}

	const release = await findLatestRelease(install.tagPrefix);
	const asset = release?.assets.find((candidate) => install.isAsset(candidate.name));
	return asset ? { name: asset.name, downloadUrl: asset.browser_download_url } : null;
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
		"Use /paperclock.apk, /saintjohn.apk, or /parlo.apk to download the latest Android release, or /fuego.dmg for Fuego for macOS.",
		{
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		},
	);
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
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
