import { shortlinks } from "./shortlinks";

const shortDomain = "jnay.me";

type Env = {
	ASSETS: {
		fetch(request: Request): Promise<Response>;
	};
};

function redirect(destination: string, source: URL): Response {
	const target = new URL(destination);

	for (const [key, value] of source.searchParams) {
		target.searchParams.append(key, value);
	}

	return Response.redirect(target.toString(), 302);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.hostname === `www.${shortDomain}`) {
			url.hostname = shortDomain;
			return Response.redirect(url.toString(), 308);
		}

		if (url.hostname === shortDomain) {
			const destination = shortlinks[url.pathname as keyof typeof shortlinks];

			if (destination) {
				return redirect(destination, url);
			}

			return new Response("Short link not found", { status: 404 });
		}

		return env.ASSETS.fetch(request);
	},
};
