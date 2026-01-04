import { defineCollection, z } from "astro:content";

const linksCollection = defineCollection({
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

export const collections = {
	links: linksCollection,
};
