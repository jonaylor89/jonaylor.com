import Script from 'next/script'

interface PlausibleAnalyticsProps {
  domain: string
}

export default function PlausibleAnalytics({ domain }: PlausibleAnalyticsProps) {
  if (!domain) {
    return null
  }

  return (
    <Script
      defer
      data-domain={domain}
      src="https://plausible.io/js/script.js"
      strategy="afterInteractive"
    />
  )
}