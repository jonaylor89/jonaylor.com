'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'

export default function ProgressBar() {
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState(0)
  const pathname = usePathname()

  useEffect(() => {
    const handleStart = () => {
      setLoading(true)
      setProgress(0)
    }

    const handleComplete = () => {
      setProgress(100)
      setTimeout(() => {
        setLoading(false)
        setProgress(0)
      }, 200)
    }

    // Simulate progress during navigation
    let interval: NodeJS.Timeout

    if (loading) {
      interval = setInterval(() => {
        setProgress(prev => {
          if (prev < 90) {
            return prev + Math.random() * 10
          }
          return prev
        })
      }, 200)
    }

    // Listen for pathname changes (which happen on navigation)
    const startTime = Date.now()
    handleStart()

    // Complete after a short delay to simulate loading
    const timeout = setTimeout(() => {
      handleComplete()
    }, 500)

    return () => {
      if (interval) clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [pathname])

  if (!loading) return null

  return (
    <div className="fixed top-0 left-0 right-0 z-50">
      <div
        className="h-1 bg-blue-500 dark:bg-blue-400 transition-all duration-300 ease-out"
        style={{ width: `${progress}%` }}
      />
    </div>
  )
}