import { requestQuote } from "../quote-request";

/** Request a deposit address when the server allows live swaps. */
export function POST(request: Request) {
  return requestQuote(request, true);
}
