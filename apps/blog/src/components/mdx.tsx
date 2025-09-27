import React from "react";
import Callout from "./mdx/Callout";

function YouTubeEmbed({ url }: { url: string }) {
  const getYouTubeId = (url: string) => {
    const regex =
      /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
    const match = url.match(regex);
    return match ? match[1] : null;
  };

  const videoId = getYouTubeId(url);

  if (!videoId) {
    return (
      <a href={url} target="_blank" rel="noopener noreferrer">
        {url}
      </a>
    );
  }

  return (
    <div className="relative w-full aspect-video my-6">
      <iframe
        src={`https://www.youtube.com/embed/${videoId}`}
        title="YouTube video player"
        frameBorder="0"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
        allowFullScreen
        className="absolute top-0 left-0 w-full h-full rounded-lg"
      />
    </div>
  );
}

function YouTube({ url }: { url: string }) {
  return <YouTubeEmbed url={url} />;
}

export const mdxComponents = {
  Callout,
  YouTube,
  a: ({ href, children, ...props }: any) => {
    const isExternal = href?.startsWith("http");
    return (
      <a
        href={href}
        target={isExternal ? "_blank" : undefined}
        rel={isExternal ? "noopener noreferrer" : undefined}
        {...props}
      >
        {children}
      </a>
    );
  },
  ul: ({ children, ...props }: any) => (
    <ul className="list-disc list-inside space-y-2 my-4" {...props}>
      {children}
    </ul>
  ),
  li: ({ children, ...props }: any) => (
    <li className="ml-0" {...props}>
      {children}
    </li>
  ),
};
