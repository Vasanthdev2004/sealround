import { parseChapterShare } from "@/lib/chapters/chapter-share";
import { isNearMode } from "@/lib/config";
import { renderChapterPreview } from "@/lib/og/chapter-image";

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams;
  const [id] = query.getAll("sale");
  const [round] = query.getAll("round");
  const share = id && round && query.getAll("sale").length === 1 && query.getAll("round").length === 1
    ? parseChapterShare(id, round, query, !isNearMode()) : null;
  return renderChapterPreview(share);
}
