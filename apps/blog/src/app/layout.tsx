import type { Metadata } from "next";
import "./globals.css";
import { JetBrains_Mono, PT_Serif } from "next/font/google";
import {
  generateMetadata as generateSEOMetadata,
  generateJSONLD,
} from "@/lib/seo";
import { ThemeProvider } from "@/components/ThemeProvider";
import PlausibleProvider from "next-plausible";

const cormorantGaramond = PT_Serif({
  variable: "--font-serif",
  weight: "400",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = generateSEOMetadata();

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${cormorantGaramond.variable} ${jetbrainsMono.variable} antialiased`}
    >
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(generateJSONLD("website")),
          }}
        />
      </head>
      <body>
        <PlausibleProvider domain="blog.jonaylor.com">
          <ThemeProvider
            attribute="class"
            defaultTheme="dark"
            enableSystem
            disableTransitionOnChange
          >
            {children}
          </ThemeProvider>
        </PlausibleProvider>
      </body>
    </html>
  );
}
