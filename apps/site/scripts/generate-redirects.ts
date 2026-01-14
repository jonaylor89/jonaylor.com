#!/usr/bin/env npx tsx
/**
 * Generate provider-specific redirect configs from redirects.json
 *
 * Usage: npx tsx scripts/generate-redirects.ts [provider]
 * Providers: vercel, netlify, cloudflare
 *
 * This keeps redirects.json as the single source of truth,
 * making provider migrations painless.
 */

import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

interface DomainRedirect {
	from: string;
	toPrefix: string;
	status: number;
	description?: string;
}

interface PathRedirect {
	from: string;
	to: string;
	status: number;
}

interface RedirectsManifest {
	version: number;
	description: string;
	domainRedirects: DomainRedirect[];
	pathRedirects: PathRedirect[];
}

const manifest: RedirectsManifest = JSON.parse(
	readFileSync(join(rootDir, "redirects.json"), "utf-8")
);

function generateVercel(): string {
	const redirects = [
		// Domain redirects
		...manifest.domainRedirects.map((r) => ({
			source: "/:path*",
			has: [{ type: "host", value: r.from }],
			destination: `https://jonaylor.com${r.toPrefix}/:path*`,
			permanent: r.status === 301,
		})),
		// Path redirects
		...manifest.pathRedirects.map((r) => ({
			source: r.from,
			destination: r.to,
			permanent: r.status === 301,
		})),
	];

	return JSON.stringify(
		{
			$schema: "https://openapi.vercel.sh/vercel.json",
			redirects,
		},
		null,
		2
	);
}

function generateNetlify(): string {
	const lines: string[] = [
		"# Generated from redirects.json - do not edit directly",
		"# Domain redirects (requires domain aliases in Netlify settings)",
		"",
	];

	// Netlify uses _redirects file format
	// For domain redirects, the domains must be set as aliases
	for (const r of manifest.domainRedirects) {
		lines.push(`# ${r.description || r.from}`);
		lines.push(`https://${r.from}/* https://jonaylor.com${r.toPrefix}/:splat ${r.status}`);
	}

	lines.push("");
	lines.push("# Path redirects");

	for (const r of manifest.pathRedirects) {
		lines.push(`${r.from} ${r.to} ${r.status}`);
	}

	return lines.join("\n");
}

function generateCloudflare(): string {
	// Cloudflare Pages uses _redirects (same as Netlify) or can use _routes.json
	return generateNetlify();
}

function generateNginx(): string {
	const lines: string[] = [
		"# Generated from redirects.json - do not edit directly",
		"# Add these to your nginx server block",
		"",
		"# Domain redirects (add to respective server blocks)",
	];

	for (const r of manifest.domainRedirects) {
		lines.push(`# ${r.description || r.from}`);
		lines.push(`server {`);
		lines.push(`    server_name ${r.from};`);
		lines.push(`    return ${r.status} https://jonaylor.com${r.toPrefix}$request_uri;`);
		lines.push(`}`);
		lines.push("");
	}

	lines.push("# Path redirects (add to main server block)");

	for (const r of manifest.pathRedirects) {
		lines.push(`rewrite ^${r.from.replace(".", "\\.")}$ ${r.to} permanent;`);
	}

	return lines.join("\n");
}

const generators: Record<string, () => string> = {
	vercel: generateVercel,
	netlify: generateNetlify,
	cloudflare: generateCloudflare,
	nginx: generateNginx,
};

const provider = process.argv[2] || "vercel";

if (!generators[provider]) {
	console.error(`Unknown provider: ${provider}`);
	console.error(`Available: ${Object.keys(generators).join(", ")}`);
	process.exit(1);
}

const output = generators[provider]();

const outputFiles: Record<string, string> = {
	vercel: "vercel.json",
	netlify: "public/_redirects",
	cloudflare: "public/_redirects",
	nginx: "nginx-redirects.conf",
};

const outputPath = join(rootDir, outputFiles[provider]);
writeFileSync(outputPath, output);

console.log(`✓ Generated ${outputFiles[provider]} for ${provider}`);
console.log(`  ${manifest.domainRedirects.length} domain redirects`);
console.log(`  ${manifest.pathRedirects.length} path redirects`);
