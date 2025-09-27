import Link from 'next/link'
import SponsorButton from './SponsorButton'

export default function Footer() {
  return (
    <footer className="mt-16 pt-8 border-t border-gray-200 dark:border-gray-700">
      <div className="flex flex-col items-center gap-6">
        <SponsorButton username="jonaylor89" />

        <nav aria-label="External links" className="flex flex-wrap justify-center gap-4 text-sm">
          <a
            href="https://jonaylor.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            about me
          </a>
          <a
            href="https://bio.jonaylor.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            projects
          </a>
          <a
            href="https://github.com/jonaylor89"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            github
          </a>
          <a
            href="https://linkedin.com/in/john-naylor"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            linkedin
          </a>
          <a
            href="https://x.com/jonaylor89"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            X/twitter
          </a>
        </nav>
      </div>
    </footer>
  )
}
