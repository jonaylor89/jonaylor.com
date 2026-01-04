export function calculateReadTime(content: string): number {
	// Average reading speed is 200-250 words per minute
	// We'll use 200 to be conservative
	const wordsPerMinute = 200;

	// Remove markdown syntax, HTML tags, and code blocks for more accurate count
	const cleanContent = content
		.replace(/```[\s\S]*?```/g, "") // Remove code blocks
		.replace(/`[^`]+`/g, "") // Remove inline code
		.replace(/#{1,6}\s+/g, "") // Remove markdown headers
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Convert links to just text
		.replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold markdown
		.replace(/\*([^*]+)\*/g, "$1") // Remove italic markdown
		.replace(/<[^>]+>/g, "") // Remove HTML tags
		.replace(/\s+/g, " ") // Normalize whitespace
		.trim();

	const wordCount = cleanContent.split(/\s+/).filter((word) => word.length > 0).length;
	const readTime = Math.max(1, Math.ceil(wordCount / wordsPerMinute));

	return readTime;
}

export function formatReadTime(minutes: number): string {
	if (minutes === 1) {
		return "1 min read";
	}
	return `${minutes} min read`;
}
