import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { THEME_BOOTSTRAP } from "@/components/shell/theme-preference";
import { siteUrl } from "@/lib/og/site-url";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

// Inter with its optical-size axis, so large headings get the display cut automatically.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], axes: ["opsz"] });
// Mono is for sealed ciphertext and hashes only.
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/**
 * Share cards: each route group has an `opengraph-image.tsx` (the landing
 * page, the app, one sale). og:title and og:description come from each page's
 * title and description; X reads the same image, title and description.
 * metadataBase makes the card URLs absolute (lib/og/site-url.ts).
 */
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  applicationName: "Sealround",
  title: { default: "Sealround: sealed bids, one price", template: "%s · Sealround" },
  description:
    "Sealed-bid, single-price sales on NEAR. Bids stay hidden in a TEE until close, everyone pays one clearing price, pay from any chain.",
  openGraph: { siteName: "Sealround", type: "website", locale: "en_US" },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  colorScheme: "light dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${inter.variable} ${geistMono.variable} antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <WalletProvider>
          {children}
        </WalletProvider>
      </body>
    </html>
  );
}
