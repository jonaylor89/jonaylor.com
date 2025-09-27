const VIEW_COUNT_KEY = 'blog_view_counts'

export interface ViewCount {
  [slug: string]: number
}

export function getViewCounts(): ViewCount {
  if (typeof window === 'undefined') return {}

  try {
    const stored = localStorage.getItem(VIEW_COUNT_KEY)
    return stored ? JSON.parse(stored) : {}
  } catch {
    return {}
  }
}

export function incrementViewCount(slug: string): number {
  if (typeof window === 'undefined') return 0

  const counts = getViewCounts()
  const newCount = (counts[slug] || 0) + 1
  counts[slug] = newCount

  try {
    localStorage.setItem(VIEW_COUNT_KEY, JSON.stringify(counts))
  } catch {
    // Handle localStorage errors gracefully
  }

  return newCount
}

export function getViewCount(slug: string): number {
  const counts = getViewCounts()
  return counts[slug] || 0
}