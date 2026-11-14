import { unstable_cache } from "next/cache";
import { MockClient } from "@/lib/client/mock";
import { appConfig } from "@/lib/config";
import { readMockLandingMetrics, readNearLandingMetrics } from "@/lib/landing-metrics";
import { LANDING_METRICS_REFRESH_SECONDS, type LandingMetrics } from "@/lib/landing-metrics-format";

const refreshSeconds = LANDING_METRICS_REFRESH_SECONDS;
let pending: Promise<LandingMetrics> | undefined;

const read = unstable_cache(
  async (
    config: ReturnType<typeof appConfig>,
    factory?: string,
    legacyEscrow?: string,
  ) => config.mode === "near"
    ? readNearLandingMetrics(config, undefined, factory, legacyEscrow)
    : readMockLandingMetrics(new MockClient()),
  ["landing-metrics-v1"],
  { revalidate: refreshSeconds },
);

export async function GET() {
  try {
    const config = appConfig();
    const readOnlyConfig = config.mode === "near"
      ? { ...config, near: { ...config.near, devAccounts: [] } }
      : config;
    pending ??= read(readOnlyConfig, process.env.NEXT_PUBLIC_CHAPTERS_FACTORY, process.env.NEXT_PUBLIC_CHAPTERS_CONTRACT)
      .finally(() => { pending = undefined; });
    const snapshot = await pending;
    const age = Math.floor((Date.now() - snapshot.updatedAt) / 1000);
    const remaining = Math.max(0, refreshSeconds - age);
    return Response.json(snapshot, {
      headers: { "Cache-Control": `public, max-age=0, s-maxage=${remaining}` },
    });
  } catch {
    return Response.json({ error: "Could not read the activity totals." }, {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
