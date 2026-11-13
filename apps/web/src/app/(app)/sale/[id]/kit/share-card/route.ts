import { genericCard } from "@/app/api/og/countdown/image";
import { isNearMode } from "@/lib/config";
import { loadOgFonts } from "@/lib/og/fonts";
import { saleImage } from "@/lib/og/sale-image";

/**
 * The sale's link preview at an address the launch kit can show and save:
 * the same image as the sale page's `opengraph-image` (whose own address
 * carries a build hash). NEAR mode: the sale's card from the contract. Mock
 * mode: the generic app card, as the sale page's preview is. Always an image.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    if (!isNearMode()) return genericCard(await loadOgFonts().catch(() => undefined));
    const { id } = await params;
    return await saleImage(id);
  } catch {
    return genericCard(undefined);
  }
}
