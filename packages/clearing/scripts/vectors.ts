/** Writes crates/clearing/tests/vectors.json. Run: pnpm --filter @fairground/clearing vectors */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { VECTORS_PATH, buildVectors, renderVectors } from "./vector-cases";

const path = fileURLToPath(VECTORS_PATH);
const vectors = buildVectors();
mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, renderVectors(vectors));
console.log(
  `wrote ${path}: ${vectors.clearing.length} clearing, ${vectors.checks.length} checks, ` +
    `${vectors.prorate.length} prorate, ${vectors.mul_div.length} mul_div, ` +
    `${vectors.bid_set_hash.length} bid-set hash, ${vectors.commitment.length} commitment vectors`,
);
