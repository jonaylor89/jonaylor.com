import type { Metadata } from "next";
import "./globals.css";
import { JetBrains_Mono, PT_Serif } from "next/font/google";
import {
  generateMetadata as generateSEOMetadata,
  generateJSONLD,
} from "@/lib/seo";
import { ThemeProvider } from "@/components/ThemeProvider";
import PlausibleAnalytics from "@/components/PlausibleAnalytics";

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
        <PlausibleAnalytics
          domain={process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN || ""}
        />
      </head>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
