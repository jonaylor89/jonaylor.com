'use client'

import { HeartIcon } from '@heroicons/react/24/outline'

interface SponsorButtonProps {
  username: string
  className?: string
}

export default function SponsorButton({ username, className = '' }: SponsorButtonProps) {
  const sponsorUrl = `https://github.com/sponsors/${username}`

  return (
    <a
      href={sponsorUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-2 px-4 py-2 bg-pink-50 dark:bg-pink-900/20 hover:bg-pink-100 dark:hover:bg-pink-900/40 text-pink-600 dark:text-pink-400 border border-pink-200 dark:border-pink-800 rounded-md transition-colors duration-200 text-sm font-medium ${className}`}
      title={`Sponsor ${username} on GitHub`}
    >
      <HeartIcon className="w-4 h-4" />
      <span>Buy me a coffee</span>
    </a>
  )
}
