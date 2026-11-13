/**
 * The absolute origin that share cards and other absolute metadata URLs are
 * built on (`metadataBase` in the root layout).
 *
 * In order: NEXT_PUBLIC_APP_URL (the app's own host, see .env.example), then
 * the Vercel URL of this deployment (the production domain on production,
 * the branch or deployment URL on a preview), then localhost.
 */

type SiteEnv = {
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL_ENV?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_BRANCH_URL?: string;
  VERCEL_URL?: string;
  PORT?: string;
};

function httpUrl(raw: string | undefined): URL | null {
  const t = raw?.trim();
  if (!t) return null;
  try {
    // Vercel's variables are bare hosts; anything with a scheme is taken as written.
    const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

export function siteUrl(env: SiteEnv = process.env as SiteEnv): URL {
  const app = httpUrl(env.NEXT_PUBLIC_APP_URL);
  if (app) return app;
  const vercel =
    env.VERCEL_ENV === "production"
      ? httpUrl(env.VERCEL_PROJECT_PRODUCTION_URL) ?? httpUrl(env.VERCEL_URL)
      : httpUrl(env.VERCEL_BRANCH_URL) ?? httpUrl(env.VERCEL_URL);
  if (vercel) return vercel;
  const port = /^\d+$/.test(env.PORT ?? "") ? env.PORT : "3000";
  return new URL(`http://localhost:${port}`);
}
