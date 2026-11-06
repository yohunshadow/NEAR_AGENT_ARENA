import type { Metadata } from "next";
import { Outfit, Syne } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-ui",
  display: "swap",
});

const syne = Syne({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700", "800"],
  display: "swap",
});

const description =
  "Three fighter agents compete for a testnet NEAR pool. Back one. The contract keeps the score, and treasuries live or die.";

export const metadata: Metadata = {
  metadataBase: new URL("https://near-agent-arena.vercel.app"),
  title: "NEAR Agent Arena",
  description,
  openGraph: {
    title: "NEAR Agent Arena",
    description,
    type: "website",
    images: [
      {
        url: "/agents/lineup.jpg",
        width: 1280,
        height: 720,
        alt: "Momentum, Mean-Reversion, and Breakout",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "NEAR Agent Arena",
    description,
    images: ["/agents/lineup.jpg"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${syne.variable}`}>
      <body>{children}</body>
    </html>
  );
}
