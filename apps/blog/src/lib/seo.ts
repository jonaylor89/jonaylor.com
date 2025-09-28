import { Metadata } from "next";
import { Post } from "./posts";

const siteConfig = {
  name: "Buried Treasure | Johannes Naylor",
  description: "Da Beep Boops",
  url: process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  author: {
    name: "Johannes Naylor",
    email: "jonaylor89@gmail.com",
    twitter: "@jonaylor89",
  },
  keywords: [
    "blog",
    "technology",
    "software development",
    "programming",
    "web development",
  ],
};

interface SEOProps {
  title?: string;
  description?: string;
  path?: string;
  image?: string;
  article?: boolean;
  publishedTime?: string;
  modifiedTime?: string;
  tags?: string[];
}

export function generateMetadata({
  title,
  description,
  path = "",
  image,
  article = false,
  publishedTime,
  modifiedTime,
  tags = [],
}: SEOProps = {}): Metadata {
  const url = `${siteConfig.url}${path}`;
  const metaTitle = title ? `${title} | ${siteConfig.name}` : siteConfig.name;
  const metaDescription = description || siteConfig.description;
  const metaImage = image || `${siteConfig.url}/og-image.png`;

  const metadata: Metadata = {
    title: metaTitle,
    description: metaDescription,
    keywords: [...siteConfig.keywords, ...tags],
    authors: [{ name: siteConfig.author.name, url: siteConfig.url }],
    creator: siteConfig.author.name,
    publisher: siteConfig.author.name,
    alternates: {
      canonical: url,
    },
    openGraph: {
      type: article ? "article" : "website",
      url,
      title: metaTitle,
      description: metaDescription,
      siteName: siteConfig.name,
      images: [
        {
          url: metaImage,
          width: 1200,
          height: 630,
          alt: metaTitle,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      site: siteConfig.author.twitter,
      creator: siteConfig.author.twitter,
      title: metaTitle,
      description: metaDescription,
      images: [metaImage],
    },
    robots: {
      index: true,
      follow: true,
      googleBot: {
        index: true,
        follow: true,
        "max-video-preview": -1,
        "max-image-preview": "large",
        "max-snippet": -1,
      },
    },
  };

  if (article && publishedTime) {
    metadata.openGraph = {
      ...metadata.openGraph,
      type: "article",
      publishedTime,
      modifiedTime: modifiedTime || publishedTime,
      authors: [siteConfig.author.name],
      tags,
    };
  }

  return metadata;
}

export function generatePostMetadata(post: Post): Metadata {
  const coverImageUrl = post.frontmatter.coverImage
    ? `${siteConfig.url}${post.frontmatter.coverImage}`
    : undefined;

  return generateMetadata({
    title: post.frontmatter.title,
    description: post.frontmatter.excerpt,
    path: `/posts/${post.slug}`,
    image: coverImageUrl,
    article: true,
    publishedTime: new Date(post.frontmatter.date).toISOString(),
    tags: post.frontmatter.tags,
  });
}

interface ArticleData {
  title: string;
  description: string;
  slug: string;
  date: string;
  tags?: string[];
  coverImage?: string;
  content?: string;
}

interface ArticleLD {
  "@context": string;
  "@type": string;
  url: string;
  name: string;
  description: string;
  author: {
    "@type": string;
    name: string;
    email: string;
    url: string;
  };
  headline: string;
  datePublished: string;
  dateModified: string;
  keywords?: string;
  articleSection: string;
  wordCount: number;
  image?: {
    "@type": string;
    url: string;
    width: number;
    height: number;
  };
}

export function generateJSONLD(
  type: "website" | "article",
  data?: ArticleData,
) {
  const baseLD = {
    "@context": "https://schema.org",
    "@type": type === "website" ? "Website" : "Article",
    url: siteConfig.url,
    name: siteConfig.name,
    description: siteConfig.description,
    author: {
      "@type": "Person",
      name: siteConfig.author.name,
      email: siteConfig.author.email,
      url: siteConfig.url,
    },
  };

  if (type === "article" && data) {
    const articleLD: ArticleLD = {
      ...baseLD,
      "@type": "Article",
      headline: data.title,
      description: data.description,
      url: `${siteConfig.url}/posts/${data.slug}`,
      datePublished: new Date(data.date).toISOString(),
      dateModified: new Date(data.date).toISOString(),
      keywords: data.tags?.join(", "),
      articleSection: "Technology",
      wordCount: data.content?.split(" ").length || 0,
    };

    if (data.coverImage) {
      articleLD.image = {
        "@type": "ImageObject",
        url: `${siteConfig.url}${data.coverImage}`,
        width: 800,
        height: 400,
      };
    }

    return articleLD;
  }

  return baseLD;
}

export { siteConfig };
