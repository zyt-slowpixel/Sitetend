import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Hana Sato — Ceramics",
  description: "Hand-thrown stoneware made in a small studio in Portland, Oregon.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
