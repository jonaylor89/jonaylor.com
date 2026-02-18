import { defineCollection, z } from "astro:content";

const posts = defineCollection({
	type: "content",
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
	type: "data",
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
