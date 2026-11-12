import { SiteShell } from "@/components/site/site-shell";

/** The public site: the landing page at `/`. The app has its own shell in `(app)`. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return <SiteShell>{children}</SiteShell>;
}
