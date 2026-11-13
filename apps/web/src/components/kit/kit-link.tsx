"use client";

import { Check, Download, Link2 } from "lucide-react";
import { kitFileName } from "@/app/api/og/countdown/share";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import type { Sale } from "@/lib/types";
import { CopyStatus, saveAs, useCopy, useSaleUrl } from "./kit-bits";
import { QR_MARGIN, qrMatrix, qrSvg, svgDataUrl } from "./qr";

/** Pixels per module in the downloaded PNG: about 1,000 px for a typical sale link. */
const PNG_SCALE = 24;

/** The QR code as a PNG, drawn on a canvas in the browser. */
function qrPng(m: boolean[][]): Promise<Blob | null> {
  const side = m.length + 2 * QR_MARGIN;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side * PNG_SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve(null);
  // The file's own colours, not the page's: a scanner needs dark on light.
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "black";
  m.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) ctx.fillRect((x + QR_MARGIN) * PNG_SCALE, (y + QR_MARGIN) * PNG_SCALE, PNG_SCALE, PNG_SCALE);
    }),
  );
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

/** The sale page's link with Copy, and the same link as a QR code to show on a stream, a slide or a poster. */
export function KitLink({ sale }: { sale: Sale }) {
  const url = useSaleUrl(sale.id);
  const { state, text, copy } = useCopy();
  const sym = sale.config.tokenSymbol;
  const matrix = url ? qrMatrix(url) : null;
  const svg = matrix ? qrSvg(matrix, { title: `QR code: ${url}` }) : null;

  const savePng = async () => {
    if (!matrix) return;
    const blob = await qrPng(matrix);
    if (blob) saveAs(blob, kitFileName(sym, "qr", "png"));
  };

  return (
    <Panel title="Watch link" subtitle="Bids, the countdown and, after the close, the reveal: all on this page.">
      <p className="num text-small break-all text-fg select-all">{url ?? " "}</p>
      <div className="mt-3">
        <Button
          size="sm"
          variant="tactile"
          className="max-sm:h-10"
          disabled={!url}
          onClick={() => url && void copy(url)}
          icon={state === "copied" ? <Check className="size-3.5 text-ok" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
        >
          {state === "copied" ? "Link copied" : "Copy link"}
        </Button>
      </div>
      <CopyStatus state={state} text={text} done="Watch link copied." className="mt-2" />

      <div className="mt-5 border-t border-line pt-5">
        <h3 className="text-h3 text-fg">QR code</h3>
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div className="size-[168px] shrink-0 overflow-hidden rounded-tile ring-1 ring-line">
            {svg ? (
              // A data URL made here from the link: next/image has nothing to optimise.
              // eslint-disable-next-line @next/next/no-img-element
              <img src={svgDataUrl(svg)} alt={`QR code for ${url}`} width={168} height={168} className="block size-full" />
            ) : (
              <div className="shimmer size-full" aria-hidden />
            )}
          </div>
          <div className="flex flex-col items-start gap-2">
            <Button
              size="sm"
              variant="outline"
              className="max-sm:h-10"
              disabled={!matrix}
              onClick={() => void savePng()}
              icon={<Download className="size-3.5" aria-hidden />}
            >
              Download PNG
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="max-sm:h-10"
              disabled={!svg}
              onClick={() => svg && saveAs(new Blob([svg], { type: "image/svg+xml" }), kitFileName(sym, "qr", "svg"))}
              icon={<Download className="size-3.5" aria-hidden />}
            >
              Download SVG
            </Button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
