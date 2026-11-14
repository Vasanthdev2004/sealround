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
export const REPO_URL = "https://github.com/Vasanthdev2004/sealround";

/**
 * The hosted app in NEAR mode on testnet, where real wallets connect. The
 * simulated demo links here, because its own wallet is a demo account.
 */
export const TESTNET_APP_URL = "https://sealround-testnet.vercel.app";

/** The testnet app's sales board, opening the wallet picker on arrival. */
export const TESTNET_CONNECT_URL = `${TESTNET_APP_URL}/sales?connect=wallet`;
