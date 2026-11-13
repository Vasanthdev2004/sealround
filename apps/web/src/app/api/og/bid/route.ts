import type { NextRequest } from "next/server";
import { bidImage, genericCard } from "./image";

/**
 * The "I'm in" bid card, 1200 x 630 PNG: `/api/og/bid?sale=<id>&bid=<n>`,
 * plus `&by=<account>` when the bidder chose to show it, and in mock mode
 * `&name=`, `&ticker=` and `&end=` (the server cannot read a simulated sale).
 * The sale page's metadata points here when its link has `?bid=` (see
 * `metadata.ts`). Always an image: any failure is the generic app card.
 *
 * Nothing is fetched from a parameter: in NEAR mode the sale and its bid
 * come from the configured contract, and the token icon only from its view.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await bidImage(request.nextUrl.searchParams);
  } catch {
    return genericCard(undefined);
  }
}
