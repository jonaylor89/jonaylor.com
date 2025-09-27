import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { generateMetadata as generateSEOMetadata, generateJSONLD, siteConfig } from '@/lib/seo';
import { ThemeProvider } from '@/components/ThemeProvider';
import PlausibleAnalytics from '@/components/PlausibleAnalytics';
import ProgressBar from '@/components/ProgressBar';

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = generateSEOMetadata();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(generateJSONLD('website'))
          }}
        />
        <PlausibleAnalytics domain={process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN || ''} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          <ProgressBar />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
