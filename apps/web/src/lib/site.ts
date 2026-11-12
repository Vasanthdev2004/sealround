/**
 * Where things live. The landing page is `/`; the app's home, the sales
 * board, is `/sales`. When the app has its own host (for example
 * app.sealround.xyz, set as NEXT_PUBLIC_APP_URL), `src/proxy.ts` serves the
 * board at that host's `/` and the landing page links there.
 */
export const APP_HOME = "/sales";

/** Absolute app origin without a trailing slash, or "" when the app shares the landing page's host. */
export const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/+$/, "");

/** A link into the app from the landing page: same host by default, the app host when one is set. */
export function appHref(path: string = APP_HOME): string {
  if (!APP_URL) return path;
  return `${APP_URL}${path === APP_HOME ? "/" : path}`;
}

/** The public source repository. */
export const REPO_URL = "https://github.com/Vasanthdev2004/fairground";
