export const NAV = [
  { href: "/sales", label: "Sales", match: (p: string) => p.startsWith("/sale") },
  { href: "/create", label: "Launch a sale", match: (p: string) => p.startsWith("/create") },
  { href: "/judge", label: "Judge mode", match: (p: string) => p.startsWith("/judge") },
  { href: "/arena", label: "Bot Arena", match: (p: string) => p.startsWith("/arena") },
  { href: "/how", label: "How it works", match: (p: string) => p.startsWith("/how") },
] as const;
