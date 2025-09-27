import type { MetadataRoute } from 'next'
import { generateMetadata } from '@/lib/seo'

export default function manifest(): MetadataRoute.Manifest {
  const metadata = generateMetadata()

  return {
    name: metadata.title as string,
    short_name: 'Buried Treasure',
    description: metadata.description as string,
    start_url: '/',
    display: 'standalone',
    icons: [
      {
        src: '/favicon.ico',
        sizes: 'any',
        type: 'image/x-icon',
      },
    ],
  }
}
