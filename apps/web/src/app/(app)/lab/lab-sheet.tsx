"use client";

import { useState } from "react";
import { ArrowRight, ArrowUpRight, Lock, Plus } from "lucide-react";
import { Badge, Tag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, Segmented } from "@/components/ui/field";
import { Panel } from "@/components/ui/panel";

const VARIANTS = ["primary", "tactile", "outline", "ghost", "danger"] as const;
const SIZES = ["sm", "md", "lg"] as const;

export function LabSheet() {
  const [filter, setFilter] = useState("open");
  const [mode, setMode] = useState("sealed");
  const [amount, setAmount] = useState("25");

  return (
    <div className="mt-10 grid gap-6 lg:grid-cols-2">
      <Panel title="Buttons" subtitle="Hover lightens. Press sinks and springs back." className="lg:col-span-2">
        <div className="flex flex-col gap-5">
          {VARIANTS.map((v) => (
            <div key={v} className="flex flex-wrap items-center gap-3">
              <span className="w-16 text-label text-subtle">{v}</span>
              {SIZES.map((s) => (
                <Button key={s} id={`lab-${v}-${s}`} variant={v} size={s}>
                  {v === "danger" ? "Void bid" : v === "primary" ? "Seal bid" : "Details"}
                </Button>
              ))}
              <Button variant={v} icon={<Plus className="size-4" aria-hidden />}>
                Add funds
              </Button>
              <Button variant={v}>
                Continue <ArrowRight className="size-4" aria-hidden />
              </Button>
              <Button variant={v} loading>
                Sealing
              </Button>
              <Button variant={v} disabled>
                Disabled
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-3">
            <span className="w-16 text-label text-subtle">square</span>
            <Button size="square" aria-label="Lock">
              <Lock aria-hidden />
            </Button>
            <Button variant="outline" size="square" aria-label="Open">
              <ArrowUpRight aria-hidden />
            </Button>
          </div>
        </div>
      </Panel>

      <Panel title="Segmented" subtitle="The thumb slides to the chosen option.">
        <div className="flex flex-col items-start gap-4">
          <Segmented
            label="Sales"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All", count: 6 },
              { value: "open", label: "Open", count: 1 },
              { value: "upcoming", label: "Upcoming", count: 1 },
              { value: "settled", label: "Settled", count: 3 },
              { value: "failed", label: "Refunding", count: 1 },
            ]}
          />
          <Segmented
            label="Bid privacy"
            value={mode}
            onChange={setMode}
            options={[
              { value: "sealed", label: "Enclave" },
              { value: "reveal", label: "Commit and reveal" },
            ]}
          />
        </div>
      </Panel>

      <Panel title="Fields" subtitle="Recessed well. Focus draws a soft ring.">
        <div className="grid gap-4">
          <Field
            label="Deposit"
            suffix="USDC"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            hint="Between 1 and 10 USDC"
          />
          <Field label="Max price" suffix="USDC per token" placeholder="0.002" error="Above your deposit" />
        </div>
      </Panel>

      <Panel title="Status" subtitle="A dot and a word.">
        <div className="flex flex-wrap items-center gap-2">
          <Badge dot pulse tone="accent">
            Live
          </Badge>
          <Badge dot tone="ok">
            Settled
          </Badge>
          <Badge dot tone="warn">
            Clearing
          </Badge>
          <Badge dot tone="bad">
            Refunding
          </Badge>
          <Tag>sim</Tag>
          <Tag tone="bot">bot</Tag>
        </div>
      </Panel>

      <Panel
        title="Place a sealed bid"
        subtitle="One decision area, one primary."
        action={<Tag>testnet</Tag>}
      >
        <div className="grid gap-4">
          <Field label="Tokens" suffix="FAIRT" defaultValue="12,000" />
          <Field label="Max price" suffix="USDC" defaultValue="0.0021" />
          <div className="flex flex-wrap gap-3">
            <Button variant="primary" size="lg" icon={<Lock className="size-4" aria-hidden />}>
              Seal and place bid
            </Button>
            <Button size="lg">Cancel</Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
