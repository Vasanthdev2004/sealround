/** Server-side quota shared by every 1Click upstream route and Vercel instance. */
import { createHmac } from "node:crypto";
import { isIP } from "node:net";

const WINDOW_SECONDS = 60;
const CLIENT_LIMIT = 40;
const GLOBAL_LIMIT = 300;
const QUOTA_NAMESPACE = "sealround:oneclick:quota:v1";

// Charge both limits only when both have room. A denied client leaves the
// overall allowance available to other callers. Redis owns both expirations.
const TAKE_QUOTA = `
local global = tonumber(redis.call("GET", KEYS[1]) or "0")
local client = tonumber(redis.call("GET", KEYS[2]) or "0")
local retry = 0
if global >= tonumber(ARGV[1]) then
  retry = math.max(retry, 1, redis.call("TTL", KEYS[1]))
end
if client >= tonumber(ARGV[2]) then
  retry = math.max(retry, 1, redis.call("TTL", KEYS[2]))
end
if retry > 0 then return retry end

for _, key in ipairs(KEYS) do
  if redis.call("INCR", key) == 1 then
    redis.call("EXPIRE", key, ARGV[3])
  end
end
return 0
`;

type SharedQuota = { url: URL; token: string };

/** null is an intentional absence. An incomplete or invalid pair is an error. */
function sharedQuota(): SharedQuota | null | "invalid" {
  const endpoint = process.env.ONECLICK_REDIS_URL?.trim();
  const token = process.env.ONECLICK_REDIS_TOKEN?.trim();
  if (!endpoint && !token) return null;
  if (!endpoint || !token || /\s/.test(token)) return "invalid";
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return "invalid";
    }
    return { url, token };
  } catch {
    return "invalid";
  }
}

export function oneClickSharedQuotaConfigured(): boolean {
  const config = sharedQuota();
  return config !== null && config !== "invalid";
}

function clientIdentity(request: Request): string {
  // Vercel owns this header in its managed runtime. For local/other hosts and
  // malformed headers use one shared bucket instead of trusting forwarded IPs.
  if (process.env.VERCEL !== "1") return "unidentified";
  const address = request.headers.get("x-vercel-forwarded-for")?.trim() ?? "";
  return isIP(address) ? address : "unidentified";
}

// Used only for unauthenticated previews when Redis is intentionally absent.
// A window admits at most GLOBAL_LIMIT requests, bounding the map's size.
let localWindowEnd = 0;
let localTotal = 0;
const localClients = new Map<string, number>();

function localQuota(client: string, now: number): number {
  if (now >= localWindowEnd) {
    localWindowEnd = now + WINDOW_SECONDS * 1000;
    localTotal = 0;
    localClients.clear();
  }
  const count = localClients.get(client) ?? 0;
  if (localTotal >= GLOBAL_LIMIT || count >= CLIENT_LIMIT) return Math.ceil((localWindowEnd - now) / 1000);
  localClients.set(client, count + 1);
  localTotal += 1;
  return 0;
}

async function redisQuota(config: SharedQuota, client: string): Promise<number> {
  // Avoid storing raw client addresses in Redis.
  const clientHash = createHmac("sha256", config.token).update(client).digest("hex");
  const res = await fetch(config.url, {
    method: "POST",
    headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
    body: JSON.stringify([
      "EVAL", TAKE_QUOTA, 2, `${QUOTA_NAMESPACE}:global`, `${QUOTA_NAMESPACE}:client:${clientHash}`,
      GLOBAL_LIMIT, CLIENT_LIMIT, WINDOW_SECONDS,
    ]),
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error("Quota store rejected the request.");
  const payload: unknown = await res.json();
  if (!payload || typeof payload !== "object" || !("result" in payload) || "error" in payload) {
    throw new Error("Quota store did not return a decision.");
  }
  const { result } = payload;
  if (typeof result !== "number" || !Number.isInteger(result) || result < 0 || result > WINDOW_SECONDS) {
    throw new Error("Quota store returned an invalid decision.");
  }
  return result;
}

function quotaUnavailable(): Response {
  return Response.json(
    { code: "oneclick_quota_unavailable", message: "1Click is temporarily unavailable. Try again shortly." },
    { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
  );
}

/** Call once just before contacting 1Click. null means the request can proceed. */
export async function checkOneClickQuota(request: Request, { live = false } = {}): Promise<Response | null> {
  const config = sharedQuota();
  if (config === "invalid" || (!config && live)) return quotaUnavailable();

  const client = clientIdentity(request);
  try {
    const retry = config ? await redisQuota(config, client) : localQuota(client, Date.now());
    if (retry === 0) return null;
    return Response.json(
      { code: "oneclick_rate_limited", message: "Too many 1Click requests. Try again shortly." },
      { status: 429, headers: { "cache-control": "no-store", "retry-after": String(retry) } },
    );
  } catch {
    // An unavailable or ambiguous shared counter cannot safely grant a request.
    return quotaUnavailable();
  }
}
