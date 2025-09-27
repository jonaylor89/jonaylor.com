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
}

export interface Post {
  slug: string;
  frontmatter: PostMatter;
  content: string;
  readTime: number;
}

export function getAllPosts(): Post[] {
  const fileNames = fs.readdirSync(postsDirectory);
  const allPosts = fileNames
    .filter(fileName => fileName.endsWith('.md') || fileName.endsWith('.mdx'))
    .map((fileName) => {
      const slug = fileName.replace(/\.(md|mdx)$/, '');
      const fullPath = path.join(postsDirectory, fileName);
      const fileContents = fs.readFileSync(fullPath, 'utf8');
      const { data, content } = matter(fileContents);

      return {
        slug,
        frontmatter: data as PostMatter,
        content,
        readTime: calculateReadTime(content),
      };
    });

  // Sort posts by date (newest first)
  return allPosts.sort((a, b) => {
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

    return {
      slug,
      frontmatter: data as PostMatter,
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