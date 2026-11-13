import type { NextRequest } from "next/server";
import { countdownImage, genericCard } from "./image";

/**
 * The countdown image, 1200 x 630 PNG, for a creator to post before and
 * during a sale: `/api/og/countdown?sale=<id>`, and in mock mode also
 * `&name=`, `&ticker=`, `&start=`, `&end=` and `&floor=` (the server cannot
 * read a simulated sale). Times are absolute, in UTC. Always an image: any
 * failure is the generic app card.
 *
 * Nothing is fetched from a parameter: in NEAR mode the sale comes from the
 * configured contract, and the token icon only from its view.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await countdownImage(request.nextUrl.searchParams);
  } catch {
    return genericCard(undefined);
  }
}
