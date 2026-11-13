import type { NextRequest } from "next/server";
import { genericCard } from "../bid/image";
import { winImage } from "./image";

/**
 * The winner card, 1200 x 630 PNG: `/api/og/win?sale=<id>&win=<n>`, plus
 * `&by=<account>` when the winner chose to show it, and in mock mode the
 * sale's facts (`name`, `ticker`, `got`, `dec`, `price`, `winners`, `bids`;
 * the server cannot read a simulated sale). The result page's metadata points
 * here when its link has `?win=` (see `metadata.ts`). Always an image: any
 * failure is the generic app card.
 *
 * Nothing is fetched from a parameter: in NEAR mode the sale, its result and
 * the fill come from the configured contract, and the token icon only from
 * its view.
 */
export async function GET(request: NextRequest): Promise<Response> {
  try {
    return await winImage(request.nextUrl.searchParams);
  } catch {
    return genericCard(undefined);
  }
}
