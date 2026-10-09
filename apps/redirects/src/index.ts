const REDIRECTS: Record<string, string> = {
	"blog.jonaylor.com": "https://jonaylor.com/blog",
	"bio.jonaylor.com": "https://jonaylor.com/links",
	"gm.jonaylor.com": "https://jonaylor.com/gm",
	"resume.jonaylor.com": "https://jonaylor.com/resume",
	"jonaylor.xyz": "https://jonaylor.com",
	"www.jonaylor.xyz": "https://jonaylor.com",
};

const GITHUB_RELEASES_API = "https://api.github.com/repos/jonaylor89/jonaylor.com/releases?per_page=100";
const RELEASE_CACHE_SECONDS = 600;
const RELEASE_CACHE_NAME = "github-release-cache";

const INSTALLS = {
	"/paperclock.apk": {
		name: "Paper Clock",
		tagPrefix: "paperclock-v",
	},
	"/saintjohn.apk": {
		name: "Saint John",
		tagPrefix: "saintjohn-v",
	},
	"/parlo.apk": {
		name: "Parlo",
		tagPrefix: "parlo-v",
	},
} as const;

type Install = (typeof INSTALLS)[keyof typeof INSTALLS];

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

async function getLatestApk(install: Install): Promise<ReleaseAsset | null> {
	const cache = await caches.open(RELEASE_CACHE_NAME);
	const cacheKey = new Request(`https://downloads.jonaylor.com/__release-cache/${install.tagPrefix}`);
	const cached = await cache.match(cacheKey);
	if (cached) return (await cached.json()) as ReleaseAsset;

	const response = await fetch(GITHUB_RELEASES_API, {
		headers: {
			Accept: "application/vnd.github+json",
			"User-Agent": "jonaylor-downloads-worker",
		},
	});
	if (!response.ok) throw new Error(`GitHub Releases API returned ${response.status}`);

	const releases = (await response.json()) as GitHubRelease[];
	const release = releases.find(
		(candidate) =>
			!candidate.draft &&
			!candidate.prerelease &&
			candidate.tag_name.startsWith(install.tagPrefix),
	);
	const asset = release?.assets.find((candidate) => candidate.name.endsWith(".apk"));
	if (!asset) return null;

	const latest = { name: asset.name, downloadUrl: asset.browser_download_url };
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
		"Use /paperclock.apk, /saintjohn.apk, or /parlo.apk to download the latest Android release.",
		{
			headers: { "Content-Type": "text/plain; charset=utf-8" },
		},
	);
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const install = INSTALLS[url.pathname as keyof typeof INSTALLS];

		if (install) {
			try {
				const asset = await getLatestApk(install);
				if (!asset) return new Response(`${install.name} has no published APK yet.`, { status: 404 });

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
