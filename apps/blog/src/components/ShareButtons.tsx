"use client";

import { useState } from "react";
import { ShareIcon, LinkIcon, CheckIcon } from "@heroicons/react/24/outline";

interface ShareButtonsProps {
  url: string;
  title: string;
  description?: string;
}

export default function ShareButtons({
  url,
  title,
  description,
}: ShareButtonsProps) {
  const [copied, setCopied] = useState(false);
  const hasNativeShare = typeof window !== "undefined" && "share" in navigator;

  const shareData = {
    title,
    text: description || title,
    url,
  };

  const handleNativeShare = async () => {
    if (hasNativeShare && navigator.share) {
      try {
        await navigator.share(shareData);
      } catch {
        // User cancelled sharing or sharing failed
        console.log("Share cancelled");
      }
    } else {
      // Fallback to copying URL
      handleCopyLink();
    }
  };

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = url;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const shareUrls = {
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(title)}&url=${encodeURIComponent(url)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  };

  return (
    <div className="flex items-center gap-3 py-4 border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center gap-2">
        {/* Native Share API or Copy Link */}
        <button
          onClick={handleNativeShare}
          className="flex items-center gap-1 px-3 py-2 text-sm bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-md transition-colors duration-200"
          title={hasNativeShare ? "Share" : "Copy link"}
        >
          {copied ? (
            <>
              <CheckIcon className="w-4 h-4 text-green-600 dark:text-green-400" />
              <span className="text-green-600 dark:text-green-400">
                Copied!
              </span>
            </>
          ) : (
            <>
              {hasNativeShare ? (
                <ShareIcon className="w-4 h-4" />
              ) : (
                <LinkIcon className="w-4 h-4" />
              )}
              <span>{hasNativeShare ? "Share" : "Copy"}</span>
            </>
          )}
        </button>

        {/* Twitter */}
        <a
          href={shareUrls.twitter}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-md transition-colors duration-200"
          title="Share on Twitter"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <span className="hidden sm:inline">Twitter</span>
        </a>

        {/* LinkedIn */}
        <a
          href={shareUrls.linkedin}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-3 py-2 text-sm bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 text-blue-600 dark:text-blue-400 rounded-md transition-colors duration-200"
          title="Share on LinkedIn"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
          </svg>
          <span className="hidden sm:inline">LinkedIn</span>
        </a>
      </div>
    </div>
  );
}
