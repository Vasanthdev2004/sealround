import { connection } from "next/server";
import { realSwapsOn } from "../upstream";

export async function GET() {
  await connection();
  return Response.json({ liveSwaps: realSwapsOn() }, { headers: { "cache-control": "no-store" } });
}
