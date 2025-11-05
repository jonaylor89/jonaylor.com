import { Metadata } from "next";
import { Post } from "./posts";

const siteConfig = {
  name: "Buried Treasure | Johannes Naylor",
  description: "Da Beep Boops",
  url: "https://blog.jonaylor.com",
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
    },
    twitter: {
      card: "summary_large_image",
      site: siteConfig.author.twitter,
      creator: siteConfig.author.twitter,
      title: metaTitle,
      description: metaDescription,
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

  // Only set images if explicitly provided
  if (image) {
    metadata.openGraph = {
      ...metadata.openGraph,
      images: [
        {
          url: image,
          width: 1200,
          height: 630,
          alt: metaTitle,
        },
      ],
    };
    metadata.twitter = {
      ...metadata.twitter,
      images: [image],
    };
  }

  if (article && publishedTime) {
    metadata.openGraph = {
      ...metadata.openGraph,
      type: "article",
      publishedTime,
      modifiedTime: modifiedTime || publishedTime,
      authors: [siteConfig.author.name],
      tags,
      section: "Technology",
      locale: "en_US",
    };
  }

  return metadata;
}

export function generatePostMetadata(post: Post): Metadata {
  // Only set image if post has a cover image, otherwise Next.js will use the file-based opengraph-image.png
  const coverImageUrl = post.frontmatter.coverImage
    ? `${siteConfig.url}${post.frontmatter.coverImage}`
    : undefined;

  return generateMetadata({
    title: post.frontmatter.title,
    description: post.frontmatter.excerpt,
    path: `/${post.slug}`,
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
      url: `${siteConfig.url}/${data.slug}`,
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
