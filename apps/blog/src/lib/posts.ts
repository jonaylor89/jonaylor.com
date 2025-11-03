import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { format } from 'date-fns';
import { calculateReadTime } from './readTime';

const postsDirectory = path.join(process.cwd(), 'content/posts');

export interface PostMatter {
  title: string;
  date: string;
  excerpt: string;
  tags: string[];
  coverImage?: string;
  coverImageAlt?: string;
  draft?: boolean;
}

export interface Post {
  slug: string;
  frontmatter: PostMatter;
  content: string;
  readTime: number;
}

export function getAllPosts(): Post[] {
  const fileNames = fs.readdirSync(postsDirectory);
  const includeDrafts = isDraftInclusionEnabled();
  const allPosts = fileNames
    .filter(fileName => fileName.endsWith('.md') || fileName.endsWith('.mdx'))
    .map((fileName) => {
      const slug = fileName.replace(/\.(md|mdx)$/, '');
      const fullPath = path.join(postsDirectory, fileName);
      const fileContents = fs.readFileSync(fullPath, 'utf8');
      const { data, content } = matter(fileContents);
      const frontmatter = normalizeFrontmatter(data);

      return {
        slug,
        frontmatter,
        content,
        readTime: calculateReadTime(content),
      };
    });

  const publishedPosts = includeDrafts
    ? allPosts
    : allPosts.filter(post => !post.frontmatter.draft);

  // Sort posts by date (newest first)
  return publishedPosts.sort((a, b) => {
    const dateA = new Date(a.frontmatter.date);
    const dateB = new Date(b.frontmatter.date);
    return dateB.getTime() - dateA.getTime();
  });
}

export function getPostBySlug(slug: string): Post | null {
  try {
    const fullPath = path.join(postsDirectory, `${slug}.md`);
    let fileContents: string;

    try {
      fileContents = fs.readFileSync(fullPath, 'utf8');
    } catch {
      // Try .mdx extension if .md doesn't exist
      const mdxPath = path.join(postsDirectory, `${slug}.mdx`);
      fileContents = fs.readFileSync(mdxPath, 'utf8');
    }

    const { data, content } = matter(fileContents);
    const frontmatter = normalizeFrontmatter(data);
    const includeDrafts = isDraftInclusionEnabled();

    if (frontmatter.draft && !includeDrafts) {
      return null;
    }

    return {
      slug,
      frontmatter,
      content,
      readTime: calculateReadTime(content),
    };
  } catch {
    return null;
  }
}

export function formatDate(dateString: string): string {
  return format(new Date(dateString), 'MMMM d, yyyy');
}

export function getSuggestedPosts(currentSlug: string, currentTags: string[] = [], limit: number = 3): Post[] {
  const allPosts = getAllPosts().filter(post => post.slug !== currentSlug);

  if (currentTags.length === 0) {
    return allPosts.slice(0, limit);
  }

  // Find posts with matching tags
  const postsWithMatchingTags = allPosts.filter(post =>
    post.frontmatter.tags?.some(tag => currentTags.includes(tag))
  );

  if (postsWithMatchingTags.length >= limit) {
    return postsWithMatchingTags.slice(0, limit);
  }

  // If not enough posts with matching tags, fill with latest posts
  const remainingCount = limit - postsWithMatchingTags.length;
  const remainingPosts = allPosts
    .filter(post => !postsWithMatchingTags.includes(post))
    .slice(0, remainingCount);

  return [...postsWithMatchingTags, ...remainingPosts];
}

function normalizeFrontmatter(data: unknown): PostMatter {
  const record = ensureRecord(data, 'frontmatter');

  const title = getRequiredString(record, 'title');
  const date = getDateString(record, 'date');
  const excerpt = getOptionalString(record, 'excerpt', { allowEmpty: true }) ?? '';
  const tags = getStringArray(record, 'tags');
  const coverImage = getOptionalString(record, 'coverImage');
  const coverImageAlt = getOptionalString(record, 'coverImageAlt');
  const draft = parseDraft(record.draft);

  return {
    title,
    date,
    excerpt,
    tags,
    coverImage,
    coverImageAlt,
    draft,
  };
}

function parseDraft(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', 'no', '0', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }

  return false;
}

function isDraftInclusionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_INCLUDE_DRAFTS === 'true';
}

function ensureRecord(value: unknown, context: string): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`Invalid ${context}: expected an object.`);
}

function getRequiredString(record: Record<string, unknown>, key: string): string {
  const value = getOptionalString(record, key);
  if (value === undefined) {
    throw new Error(`Invalid frontmatter: "${key}" is required and must be a non-empty string.`);
  }
  return value;
}

function getOptionalString(
  record: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string | undefined {
  const { allowEmpty = false } = options;
  const value = record[key];

  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`Invalid frontmatter: "${key}" must be a string.`);
  }

  const trimmed = value.trim();

  if (!allowEmpty && trimmed.length === 0) {
    return undefined;
  }

  return trimmed;
}

function getDateString(record: Record<string, unknown>, key: string): string {
  const value = getRequiredString(record, key);
  const timestamp = Date.parse(value);

  if (Number.isNaN(timestamp)) {
    throw new Error(`Invalid frontmatter: "${key}" must be a valid date string.`);
  }

  return value;
}

function getStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];

  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`Invalid frontmatter: "${key}" must be an array of strings.`);
  }

  return value.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`Invalid frontmatter: "${key}" array entry at index ${index} is not a string.`);
    }

    const trimmed = item.trim();

    if (!trimmed) {
      throw new Error(`Invalid frontmatter: "${key}" array entry at index ${index} cannot be empty.`);
    }

    return trimmed;
  });
}
