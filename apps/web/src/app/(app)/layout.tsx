import { AppShell } from "@/components/shell/app-shell";

/** The product: sales, launching, judge mode, the arena and the rules, inside the app shell. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
