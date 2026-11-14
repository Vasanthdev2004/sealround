"use client";

import { useState } from "react";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getClient } from "@/lib/client";
import { dateTime } from "@/lib/format";
import { publicEnvironment } from "./environment";
import { buildPublicEvidence } from "./public-evidence";

export function EvidenceExport({ saleId }: { saleId: string }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function download() {
    setBusy(true);
    setMessage(null);
    try {
      const client = getClient();
      const [sale, result, verification] = await Promise.all([
        client.getSale(saleId),
        client.getResult(saleId),
        client.verifySale(saleId).catch(() => null),
      ]);
      if (!sale) throw new Error("The sale could not be found. Refresh the page and try again.");
      const readAt = Date.now();
      const bundle = buildPublicEvidence({ sale, result, verification, environment: publicEnvironment(), readAt });
      const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `sealround-${saleId}-public-evidence.json`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setMessage(`Export prepared at ${dateTime(readAt)}.${verification ? " Check outcomes are recorded individually." : " Verification was unavailable and is marked as unavailable in the file."}`);
    } catch {
      setMessage("Could not export the public evidence. No file was created. Try again after the sale data is available.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" onClick={download} loading={busy} icon={<Download className="size-4" aria-hidden />}>Export public evidence</Button>
      <p className="max-w-[58ch] text-label text-subtle">Refreshes public reads into JSON. Includes check outcomes and quotes; excludes wallet details, private bid terms and recovery receipts.</p>
      <p className="text-label text-muted" role="status">{message}</p>
    </div>
  );
}
