import { defineCollection, z } from 'astro:content';

const posts = defineCollection({
  type: 'content',
  schema: ({ image }) => z.object({
    title: z.string(),
    date: z.coerce.date(),
    excerpt: z.string(),
    tags: z.array(z.string()).default([]),
    coverImage: image().optional(),
    coverImageAlt: z.string().optional(),
    draft: z.boolean().default(false),
  }),
});

export const collections = { posts };
