import { BookOpen, Bot, Gavel, Plus, Swords } from "lucide-react";

export const NAV = [
  { href: "/", label: "Sales", icon: Gavel, match: (p: string) => p === "/" || p.startsWith("/sale") },
  { href: "/create", label: "Launch a sale", icon: Plus, match: (p: string) => p.startsWith("/create") },
  { href: "/arena", label: "Bot Arena", icon: Swords, match: (p: string) => p.startsWith("/arena") },
  { href: "/judge", label: "Judge mode", icon: Bot, match: (p: string) => p.startsWith("/judge") },
  { href: "/how", label: "How it works", icon: BookOpen, match: (p: string) => p.startsWith("/how") },
] as const;
