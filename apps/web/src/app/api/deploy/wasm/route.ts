import { readFile } from "node:fs/promises";
import path from "node:path";
import { connection } from "next/server";

/**
 * Serves contracts/res/fairground.wasm to the /deploy page, on the dev server
 * only. The page checks the bytes against the pinned sha256 before it uses
 * them. A production build answers 404; pick the file by hand there.
 */
export async function GET() {
  await connection();
  if (process.env.NODE_ENV !== "development") return new Response("Not found", { status: 404 });
  try {
    // The dev server runs from apps/web.
    const bytes = await readFile(path.resolve(process.cwd(), "../../contracts/res/fairground.wasm"));
    return new Response(new Uint8Array(bytes), {
      headers: { "content-type": "application/wasm", "cache-control": "no-store" },
    });
  } catch {
    return new Response("contracts/res/fairground.wasm not found. Build it with scripts\\build-contracts.ps1.", {
      status: 404,
    });
  }
}
