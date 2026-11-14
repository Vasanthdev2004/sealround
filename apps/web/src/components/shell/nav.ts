export const NAV = [
  { href: "/judges", label: "For judges", primary: true, match: (p: string) => p === "/judges" },
  { href: "/sales", label: "Sales", primary: true, match: (p: string) => p.startsWith("/sale") || p.startsWith("/token/") },
  { href: "/create", label: "Launch a sale", primary: true, match: (p: string) => p.startsWith("/create") },
  { href: "/activity", label: "Activity", primary: true, match: (p: string) => p.startsWith("/activity") },
  { href: "/verify", label: "Verify", primary: true, match: (p: string) => p.startsWith("/verify") },
  { href: "/judge", label: "Judge mode", primary: false, match: (p: string) => p === "/judge" },
  { href: "/arena", label: "Bot Arena", primary: false, match: (p: string) => p.startsWith("/arena") },
  { href: "/attack", label: "Try to beat it", primary: false, match: (p: string) => p === "/attack" },
  { href: "/agents", label: "Bid with your AI agent", primary: false, match: (p: string) => p === "/agents" },
  { href: "/how", label: "How it works", primary: false, match: (p: string) => p.startsWith("/how") },
] as const;
