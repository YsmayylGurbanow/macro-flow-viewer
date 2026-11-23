import type { Metadata } from "next";
import {
  Cormorant_Garamond,
  EB_Garamond,
  IBM_Plex_Mono,
  Pinyon_Script,
} from "next/font/google";
import { Navbar } from "@/components/Navbar";
import { FolioTransitionProvider } from "@/components/FolioTransitionProvider";
import "./globals.css";

const cormorantGaramond = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-display",
});

const pinyonScript = Pinyon_Script({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-script",
});

const ebGaramond = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
  variable: "--font-serif",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "The Playfair Archival Ledger — Macro Capital-Flow Atlas",
  description:
    "Archival macro capital-flow ledger cross-referencing secular gold ratios, federal fiscal impulses, and interest rate regimes.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${cormorantGaramond.variable} ${pinyonScript.variable} ${ebGaramond.variable} ${ibmPlexMono.variable}`}
    >
      <body className="min-h-screen bg-parchment font-serif text-ink antialiased">
        <Navbar />
        <FolioTransitionProvider>{children}</FolioTransitionProvider>
      </body>
    </html>
  );
}
