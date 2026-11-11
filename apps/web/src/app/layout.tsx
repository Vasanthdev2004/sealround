import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { AppShell } from "@/components/shell/app-shell";
import { THEME_BOOTSTRAP } from "@/components/shell/theme-preference";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

// Inter with its optical-size axis, so large headings get the display cut automatically.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], axes: ["opsz"] });
// Mono is for sealed ciphertext and hashes only.
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Sealround: sealed bids, one price", template: "%s · Sealround" },
  description:
    "Sealed-bid, single-price sales on NEAR. Bids stay hidden in a TEE until close, everyone pays one clearing price, pay from any chain.",
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
          <AppShell>{children}</AppShell>
        </WalletProvider>
      </body>
    </html>
  );
}
