import type { Metadata } from "next";
import { KeyRound, Terminal } from "lucide-react";
import { SetupSnippets } from "@/components/agents/setup-snippets";
import { Tag } from "@/components/ui/badge";
import { QuietLink } from "@/components/ui/bits";
import { PageHeader, Panel } from "@/components/ui/panel";
import { REPO_URL } from "@/lib/site";
import recorded from "../../../../../../evidence/mcp-sandbox-bid.json";

export const metadata: Metadata = {
  title: "Bid with your AI agent",
  description: "Connect Sealround’s local MCP server, inspect sales and review an agent’s sealed bid before it signs.",
};

const docs = `${REPO_URL}/tree/main/apps/web/scripts/mcp`;

export default function AgentsPage() {
  return (
    <div className="flex w-full flex-col gap-6 sm:gap-8">
      <PageHeader
        title="Bid with your AI agent"
        description="Connect your agent to Sealround’s local MCP server. Read the sale rules first, then approve the price limit, spending limit and deposit cap for a sealed bid."
      />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1.42fr)_minmax(0,1fr)]">
        <Panel title="Connect your client" icon={<Terminal />}>
          <p className="mb-4 text-small text-muted">
            Open a local copy of Sealround with Node 24 and pnpm 12.3.4. Run <code className="text-fg">pnpm install --frozen-lockfile</code> from the repository root, then add this read-only testnet setup.
          </p>
          <SetupSnippets />
        </Panel>
        <Panel title="Approve a deposit cap" icon={<KeyRound />}>
          <ol className="list-decimal space-y-2.5 pl-4 text-small text-muted">
            <li>Ask the agent to call <code className="text-fg [overflow-wrap:anywhere]">sealround_list_sales</code>, then read the sale’s rules with <code className="text-fg [overflow-wrap:anywhere]">sealround_get_sale</code>.</li>
            <li>For a write, configure a dedicated testnet account’s local key file through <code className="text-fg [overflow-wrap:anywhere]">SEALROUND_KEY_FILE</code>. Use a private config and keep the key file off chat and source control. Set <code className="text-fg [overflow-wrap:anywhere]">SEALROUND_RELAYER_URL</code> if you have a testnet relayer.</li>
            <li>Review the sale ID, <code className="text-fg">max_price</code>, <code className="text-fg">max_spend</code>, and <code className="text-fg">max_deposit</code> before approving <code className="text-fg [overflow-wrap:anywhere]">sealround_place_bid</code>. Approve direct gas fees separately if the relayer cannot sponsor the call.</li>
          </ol>
          <p className="mt-4 text-small text-muted">
            <code className="text-fg">max_deposit</code> caps the public deposit on one call. Cross-sale spending has no cumulative cap. Price and spend limits stay sealed, with the recovery file on your machine.
          </p>
          <p className="mt-3 text-small"><QuietLink href={docs}>MCP settings and tool reference</QuietLink></p>
        </Panel>
      </div>
      <Panel title="Recorded sealed bid" subtitle="Captured from a completed local MCP sandbox run." action={<Tag>Sandbox</Tag>} headerClassName="flex-wrap">
        <dl className="mt-1 grid gap-px overflow-hidden rounded-tile border border-line bg-line sm:grid-cols-2">
          <div className="min-w-0 bg-elev px-4 py-3">
            <dt className="text-small font-medium text-fg">Deposit above cap refused</dt>
            <dd className="mt-1 text-small text-muted">
              {recorded.refused.attemptedDepositTestUsdc} test USDC requested under a {recorded.refused.maxDepositTestUsdc} cap.
              The tool returned <code className="text-fg">{recorded.refused.code}</code>. No transaction was sent, and the account’s balance and nonce stayed the same.
            </dd>
          </div>
          <div className="min-w-0 bg-elev px-4 py-3">
            <dt className="text-small font-medium text-fg">Sealed bid accepted</dt>
            <dd className="mt-1 text-small text-muted">
              Sale <code className="text-fg">{recorded.saleId}</code> recorded bid index {recorded.accepted.index} with a {recorded.accepted.depositTestUsdc} test USDC deposit and a {recorded.accepted.sealedBytes}-byte ciphertext. The {recorded.accepted.gasPaidBy} paid gas.
            </dd>
          </div>
        </dl>
        <p className="mt-3 text-small text-muted">
          Sandbox transaction <code className="break-all text-fg">{recorded.accepted.transaction}</code>
        </p>
        <p className="mt-1 text-label text-subtle">
          {recorded.passedChecks} checks passed · <time dateTime={recorded.recordedAt}>{recorded.recordedAt.slice(0, 10)} UTC</time>.
          The test confirmed the receipt before tearing down the local chain.
        </p>
        <p className="mt-2 text-small"><QuietLink href={`${REPO_URL}/blob/main/evidence/mcp-sandbox-bid.json`}>Read the public log</QuietLink></p>
      </Panel>
    </div>
  );
}
