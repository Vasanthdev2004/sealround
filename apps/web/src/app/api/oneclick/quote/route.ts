import { requestQuote } from "../quote-request";

/** Preview pricing. The route always requests a dry quote. */
export function POST(request: Request) {
  return requestQuote(request, false);
}
