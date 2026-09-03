export const shortlinks = {
	"/": "https://jonaylor.com",
	"/blog": "https://jonaylor.com/blog",
	"/cal": "https://cal.com/jonaylor89/30min",
	"/cv": "https://jonaylor.com/resume",
	"/github": "https://github.com/jonaylor89",
	"/linkedin": "https://www.linkedin.com/in/john-naylor",
	"/links": "https://jonaylor.com/links",
	"/telegram": "https://telegram.me/jonaylor89",
	"/work": "https://jonaylor.com/work-with-me",
	"/x": "https://x.com/jonaylor89",
} as const satisfies Record<`/${string}`, string>;
