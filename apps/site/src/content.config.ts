import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const posts = defineCollection({
	loader: glob({ base: "./src/content/posts", pattern: "**/*.{md,mdx}" }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			date: z.coerce.date(),
			excerpt: z.string().optional(),
			subtitle: z.string().optional(),
			tags: z.array(z.string()).default([]),
			coverImage: image().optional(),
			coverImageAlt: z.string().optional(),
			draft: z.boolean().default(false),
			lang: z.enum(["en", "de", "ca"]).default("en"),
		}),
});

const links = defineCollection({
	loader: glob({ base: "./src/content/links", pattern: "**/*.json" }),
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			subtitle: z.string(),
			image: image(),
			link: z.string().url(),
			order: z.number(),
			hidden: z.boolean().default(false),
		}),
});

export const collections = { posts, links };
