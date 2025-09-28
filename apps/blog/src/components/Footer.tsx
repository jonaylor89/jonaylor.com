import Link from "next/link";
import SponsorButton from "./SponsorButton";

export default function Footer() {
  return (
    <footer className="mt-16 pt-8 border-t border-gray-200 dark:border-gray-700">
      <div className="flex flex-col items-center gap-6">
        <SponsorButton username="jonaylor89" />

        <nav
          aria-label="External links"
          className="flex flex-wrap justify-center gap-4 text-sm"
        >
          <Link
            href="https://jonaylor.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            about me
          </Link>
          <Link
            href="https://bio.jonaylor.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            projects
          </Link>
          <Link
            href="https://github.com/jonaylor89"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            github
          </Link>
          <Link
            href="https://linkedin.com/in/john-naylor"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            linkedin
          </Link>
          <Link
            href="https://x.com/jonaylor89"
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white underline hover:opacity-70 transition-opacity duration-200"
          >
            X/twitter
          </Link>
        </nav>
      </div>
    </footer>
  );
}
