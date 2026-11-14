"use client";

import { useState } from "react";
import { Copy } from "lucide-react";
import { CopyStatus, useCopy } from "@/components/kit/kit-bits";
import { QuietLink } from "@/components/ui/bits";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/field";

const contract = "sealround.itzbeast.testnet";
const name = "sealround";
const configuration = JSON.stringify({
  mcpServers: {
    [name]: {
      command: "node",
      args: ["/absolute/path/to/sealround/apps/web/node_modules/tsx/dist/cli.mjs", "/absolute/path/to/sealround/apps/web/scripts/mcp/server.ts"],
      env: { SEALROUND_NETWORK: "testnet", SEALROUND_CONTRACT: contract },
    },
  },
}, null, 2);

const modes = {
  code: {
    label: "Claude Code",
    description: "Run this from the repository root, then use /mcp to check the connection.",
    docs: "https://code.claude.com/docs/en/mcp",
    snippet: `claude mcp add --env SEALROUND_NETWORK=testnet --env SEALROUND_CONTRACT=${contract} --transport stdio ${name} -- node apps/web/node_modules/tsx/dist/cli.mjs apps/web/scripts/mcp/server.ts`,
  },
  desktop: {
    label: "Claude Desktop",
    description: "Open Developer settings, choose Edit Config, then merge the sealround entry into claude_desktop_config.json. Replace the absolute paths and restart Claude Desktop.",
    docs: "https://modelcontextprotocol.io/docs/develop/connect-local-servers",
    snippet: configuration,
  },
  cursor: {
    label: "Cursor",
    description: "Merge the sealround entry into .cursor/mcp.json in your project, replace the absolute paths, then check the connection in Cursor’s MCP settings.",
    docs: "https://cursor.com/docs/mcp",
    snippet: configuration,
  },
} as const;

type Mode = keyof typeof modes;
const options = (Object.keys(modes) as Mode[]).map((value) => ({ value, label: modes[value].label }));

function Snippet({ mode }: { mode: Mode }) {
  const active = modes[mode];
  const copy = useCopy();
  return (
    <div className="space-y-3">
      <p className="text-small text-muted">{active.description}</p>
      <div className="relative min-w-0 overflow-hidden rounded-tile border border-line bg-inset">
        <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2.5">
          <span className="text-label text-muted">{active.label} · Read-only setup</span>
          <Button size="sm" variant="ghost" aria-label={`Copy ${active.label} setup`} icon={<Copy className="size-3.5" aria-hidden />}
            onClick={() => void copy.copy(active.snippet)}>
            {copy.state === "copied" ? "Copied" : "Copy"}
          </Button>
        </div>
        <pre className="max-w-full px-3 py-3 font-mono text-label leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"><code>{active.snippet}</code></pre>
      </div>
      <CopyStatus state={copy.state} text={copy.text} done="Setup copied." />
      <p className="text-small"><QuietLink href={active.docs}>{active.label} MCP documentation</QuietLink></p>
    </div>
  );
}

export function SetupSnippets() {
  const [mode, setMode] = useState<Mode>("code");
  return (
    <div className="space-y-4">
      <Segmented value={mode} onChange={setMode} options={options} label="MCP client" />
      <Snippet key={mode} mode={mode} />
    </div>
  );
}
