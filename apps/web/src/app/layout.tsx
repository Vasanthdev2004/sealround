import type { Metadata, Viewport } from "next";
import { Funnel_Display, Funnel_Sans, Geist_Mono } from "next/font/google";
import { AppShell } from "@/components/shell/app-shell";
import { WalletProvider } from "@/lib/wallet";
import "./globals.css";

const funnelSans = Funnel_Sans({ variable: "--font-funnel-sans", subsets: ["latin"] });
const funnelDisplay = Funnel_Display({ variable: "--font-funnel-display", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Fairground: sealed bids, one price", template: "%s · Fairground" },
  description:
    "Sealed-bid, single-price sales on NEAR. Bids stay hidden in a TEE until close, everyone pays one clearing price, pay from any chain.",
};

export const viewport: Viewport = {
  themeColor: "#121212",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${funnelSans.variable} ${funnelDisplay.variable} ${geistMono.variable} antialiased`}>
      <body>
        <WalletProvider>
          <AppShell>{children}</AppShell>
        </WalletProvider>
      </body>
    </html>
  );
}
