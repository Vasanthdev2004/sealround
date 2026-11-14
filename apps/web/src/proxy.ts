import { NextResponse, type NextRequest } from "next/server";

/**
 * One deployment, two hosts. The landing page lives at the root domain's `/`;
 * the app lives on a host that starts with `app.` (app.example.com in
 * production, app.localhost:3000 in development), where `/` is the sales
 * board. Every other path is the same page on either host.
 *
 * When NEXT_PUBLIC_APP_URL is set, app pages requested on the landing host
 * redirect to the app host so each page has one address. Without it (a
 * single-host preview such as the Vercel demo) nothing redirects and the app
 * is under /sales on the same host.
 */
const APP_PATHS = ["/sales", "/sale/", "/token/", "/create", "/activity", "/verify", "/judge", "/arena", "/how", "/lab"];

function isAppHost(host: string): boolean {
  return host.startsWith("app.");
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const { pathname, search } = request.nextUrl;

  if (isAppHost(host)) {
    // In-app links point at /sales, which also works here; only the bare host needs the rewrite.
    if (pathname === "/") return NextResponse.rewrite(new URL(`/sales${search}`, request.url));
    return NextResponse.next();
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (appUrl && APP_PATHS.some((p) => pathname === p || pathname.startsWith(p.endsWith("/") ? p : `${p}/`))) {
    const target = new URL(appUrl);
    target.pathname = pathname === "/sales" ? "/" : pathname;
    target.search = search;
    return NextResponse.redirect(target, 308);
  }
  return NextResponse.next();
}

export const config = {
  // Pages only: skip API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
