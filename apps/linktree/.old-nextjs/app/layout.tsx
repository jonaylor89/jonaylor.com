import type { Metadata } from "next";
import PlausibleProvider from 'next-plausible'
import "./globals.css";

export const metadata: Metadata = {
  title: "Johannes",
  description: "Linktree for Johannes Naylor",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <PlausibleProvider domain="bio.jonaylor.com">
          {children}
        </PlausibleProvider>
      </body>
    </html>
  );
}
