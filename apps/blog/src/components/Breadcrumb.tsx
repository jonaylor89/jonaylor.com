import Link from 'next/link'
import { ChevronRightIcon } from '@heroicons/react/24/outline'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbProps {
  items: BreadcrumbItem[]
}

export default function Breadcrumb({ items }: BreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6">
      <ol className="flex items-center space-x-2 text-sm text-black dark:text-white">
        {items.map((item, index) => (
          <li key={index} className="flex items-center">
            {index > 0 && (
              <ChevronRightIcon className="w-4 h-4 mx-2 text-gray-400 dark:text-gray-500" />
            )}
            {item.href ? (
              <Link
                href={item.href}
                className="hover:opacity-70 transition-opacity duration-200 underline"
              >
                {item.label}
              </Link>
            ) : (
              <span className="font-medium">{item.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  )
}