import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NEAR Agent Arena",
  description: "Three AI fighter agents compete for a testnet NEAR pool. Their treasuries live or die.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
