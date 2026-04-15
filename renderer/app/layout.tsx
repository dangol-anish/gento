import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Gento",
  description: "Manga-to-video desktop renderer",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
