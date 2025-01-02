import { Analytics } from "@vercel/analytics/next";
import type { Metadata } from "next";
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
        {children}
        <Analytics />;
      </body>
    </html>
  );
}
