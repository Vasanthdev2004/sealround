// Writes libsodium.json: sale keys and sealed bids made with libsodium-wrappers,
// the library the app seals bids with (apps/web/src/lib/crypto.ts). The Rust
// test tests/libsodium.rs derives the same keys and opens every box.
//
// Then the reverse: it has the Rust crate seal bids (examples/seal_bids.rs)
// and opens them with libsodium.
//
// It also checks canonical_bids.json (written by tests/canonical.rs) from the
// JavaScript side: canonicalBid below gives every row's plaintext byte for
// byte, and a libsodium box of it has the row's sealed lengths.
//
//   node crates/sealer/tests/fixtures/gen.mjs              keep existing boxes if the inputs did not change
//   node crates/sealer/tests/fixtures/gen.mjs --force      reseal everything (new random ciphertexts)
//   node crates/sealer/tests/fixtures/gen.mjs --skip-rust  skip the Rust-to-libsodium check (no cargo)

import { execFileSync } from "node:child_process";
import { hkdfSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..", "..");
const outFile = path.join(here, "libsodium.json");
const force = process.argv.includes("--force");
const skipRust = process.argv.includes("--skip-rust");

// The app's own copy of libsodium-wrappers.
const require = createRequire(path.join(root, "apps", "web", "package.json"));
const sodium = require("libsodium-wrappers");
await sodium.ready;

const hex = (bytes) => Buffer.from(bytes).toString("hex");
const b64 = (bytes) => Buffer.from(bytes).toString("base64");

// The canonical plaintext (BidPlaintext::to_canonical_json; the app's
// canonicalBid must match): fixed key order, no whitespace, both amounts
// left-padded with zeros to 39 digits so the length does not depend on them.
const AMOUNT_DIGITS = 39;
const canonicalBid = (p) =>
  JSON.stringify({
    sale_id: p.sale_id,
    bidder: p.bidder,
    max_price: p.max_price.padStart(AMOUNT_DIGITS, "0"),
    max_spend: p.max_spend.padStart(AMOUNT_DIGITS, "0"),
    salt: p.salt,
  });
// The format before padding: amounts as plain decimal strings. The job still
// reads it; the contract refuses its lengths.
const unpaddedBid = (p) =>
  JSON.stringify({
    sale_id: p.sale_id,
    bidder: p.bidder,
    max_price: p.max_price,
    max_spend: p.max_spend,
    salt: p.salt,
  });

// DESIGN.md "Sealer": sk = HKDF-SHA256(master, salt, "sale-key" 0 contract 0 sale_id), pk = X25519(sk).
const MASTER = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
const deriveKey = (master, contract, saleId) => {
  const info = Buffer.concat([
    Buffer.from("sale-key"),
    Buffer.from([0]),
    Buffer.from(contract),
    Buffer.from([0]),
    Buffer.from(saleId),
  ]);
  const secretKey = new Uint8Array(hkdfSync("sha256", master, Buffer.from("fairground/sealer/v1"), info, 32));
  return { contract, sale_id: saleId, secret_key: hex(secretKey), public_key: hex(sodium.crypto_scalarmult_base(secretKey)) };
};

const keys = [
  deriveKey(MASTER, "fairground.testnet", "fairt"),
  deriveKey(MASTER, "fairground.testnet", "fairt2"),
  deriveKey(MASTER, "fairground.near", "fairt"),
  deriveKey(MASTER, "fg.testnet", "a"),
];

const SALT = "0123456789abcdef0123456789abcdef";
const U128_MAX = "340282366920938463463374607431768211455";
const bid = (over) => ({
  sale_id: "fairt",
  bidder: "alice.testnet",
  max_price: "1600",
  max_spend: "5000000",
  salt: SALT,
  ...over,
});

// expect: the parsed bid (amounts as decimal strings, salt lowercase) or null.
// canonical: whether the plaintext is exactly the canonical form of `expect`.
const valid = (name, plaintext, expect, canonical = true) => ({ name, key: 0, plaintext, canonical, expect });
const invalid = (name, plaintext) => ({ name, key: 0, plaintext, canonical: false, expect: null });

const cases = [
  valid("basic", canonicalBid(bid({})), bid({})),
  valid("u128_max", canonicalBid(bid({ max_price: U128_MAX, max_spend: U128_MAX })), bid({ max_price: U128_MAX, max_spend: U128_MAX })),
  valid("zero_amounts", canonicalBid(bid({ max_price: "0", max_spend: "0" })), bid({ max_price: "0", max_spend: "0" })),
  valid(
    "escaped_strings",
    canonicalBid(bid({ sale_id: "s/ ", bidder: 'q"uote\\back\u0001\n\té✓😀' })),
    bid({ sale_id: "s/ ", bidder: 'q"uote\\back\u0001\n\té✓😀' }),
  ),
  valid("other_bidder_and_sale", canonicalBid(bid({ sale_id: "other", bidder: "mallory.testnet" })), bid({ sale_id: "other", bidder: "mallory.testnet" })),
  valid("unpadded_amounts", unpaddedBid(bid({})), bid({}), false),
  valid("leading_zeros", unpaddedBid(bid({ max_price: "0001600" })), bid({}), false),
  valid("forty_digit_amount", unpaddedBid(bid({ max_spend: "5000000".padStart(40, "0") })), bid({}), false),
  valid("uppercase_salt", canonicalBid(bid({ salt: SALT.toUpperCase() })), bid({}), false),
  valid("whitespace_and_order", JSON.stringify({ salt: SALT, max_spend: "5000000", max_price: "1600", bidder: "alice.testnet", sale_id: "fairt" }, null, 2), bid({}), false),
  invalid("number_price", JSON.stringify({ ...bid({}), max_price: 1600 })),
  invalid("negative_price", canonicalBid(bid({ max_price: "-1" }))),
  invalid("price_above_u128", canonicalBid(bid({ max_price: "340282366920938463463374607431768211456" }))),
  invalid("exponent_price", canonicalBid(bid({ max_price: "1e3" }))),
  invalid("missing_salt", JSON.stringify({ sale_id: "fairt", bidder: "alice.testnet", max_price: "1600", max_spend: "5000000" })),
  invalid("short_salt", canonicalBid(bid({ salt: SALT.slice(1) }))),
  invalid("non_hex_salt", canonicalBid(bid({ salt: `${SALT.slice(2)}zz` }))),
  invalid("extra_field", JSON.stringify({ ...bid({}), contract: "fairground.testnet" })),
  invalid("duplicate_key", '{"sale_id":"fairt","sale_id":"other","bidder":"alice.testnet","max_price":"1600","max_spend":"5000000","salt":"0123456789abcdef0123456789abcdef"}'),
  invalid("not_json", "hello"),
  invalid("empty", ""),
  // Sealed to another sale's key: it must not open with key 0.
  { ...valid("other_sale_key", canonicalBid(bid({})), bid({})), key: 1 },
];

const sameInputs = (old) =>
  old &&
  old.master === hex(MASTER) &&
  JSON.stringify(old.keys) === JSON.stringify(keys) &&
  JSON.stringify(old.boxes.map(({ ciphertext, ...rest }) => rest)) === JSON.stringify(cases);

const previous = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
const reuse = !force && sameInputs(previous);
const boxes = reuse
  ? previous.boxes
  : cases.map((c) => ({ ...c, ciphertext: b64(sodium.crypto_box_seal(sodium.from_string(c.plaintext), Buffer.from(keys[c.key].public_key, "hex"))) }));

// Every box must open with libsodium under its own key, to its plaintext.
for (const box of boxes) {
  const key = keys[box.key];
  const opened = sodium.crypto_box_seal_open(
    Buffer.from(box.ciphertext, "base64"),
    Buffer.from(key.public_key, "hex"),
    Buffer.from(key.secret_key, "hex"),
  );
  if (sodium.to_string(opened) !== box.plaintext) throw new Error(`libsodium did not round-trip ${box.name}`);
}

const fixture = {
  about:
    "Generated by crates/sealer/tests/fixtures/gen.mjs with libsodium-wrappers (the app's sealing library). " +
    "keys: HKDF-SHA256 per-sale X25519 keys from `master` (node:crypto + crypto_scalarmult_base). " +
    "boxes: crypto_box_seal of `plaintext` to keys[key].public_key; `expect` is the parsed bid or null if the plaintext must be rejected; " +
    "`canonical` means plaintext is exactly the canonical JSON of `expect`.",
  libsodium: sodium.SODIUM_VERSION_STRING,
  master: hex(MASTER),
  keys,
  boxes,
};
if (!reuse) writeFileSync(outFile, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`${reuse ? "kept" : "wrote"} ${path.relative(root, outFile)}: ${keys.length} keys, ${boxes.length} boxes (libsodium ${sodium.SODIUM_VERSION_STRING})`);

// canonical_bids.json from the JavaScript side: the same plaintext bytes, and
// a libsodium box of the stated length.
const canonicalFile = path.join(here, "canonical_bids.json");
const canonicalRows = JSON.parse(readFileSync(canonicalFile, "utf8")).rows;
for (const row of canonicalRows) {
  const plaintext = canonicalBid(row);
  if (plaintext !== row.plaintext) throw new Error(`canonicalBid differs from canonical_bids.json: ${row.plaintext}`);
  const bytes = sodium.from_string(plaintext);
  if (bytes.length !== row.plaintext_len || bytes.length !== 176 + row.sale_id.length + row.bidder.length) {
    throw new Error(`plaintext_len differs: ${row.plaintext}`);
  }
  const sealed = sodium.crypto_box_seal(bytes, Buffer.from(keys[0].public_key, "hex"));
  if (sealed.length !== row.sealed_len || b64(sealed).length !== row.sealed_base64_len) {
    throw new Error(`sealed lengths differ: ${row.plaintext}`);
  }
}
console.log(`canonical_bids.json: all ${canonicalRows.length} rows match canonicalBid and libsodium's box lengths`);

// Reverse direction: boxes sealed by the Rust crate must open with libsodium.
if (skipRust) {
  console.log("skipped the Rust-sealed check (--skip-rust)");
} else {
  const sealedBy = keys[0];
  const plaintexts = cases.filter((c) => c.key === 0 && c.canonical).map((c) => c.plaintext);
  const stdout = execFileSync(
    "cargo",
    ["run", "--quiet", "-p", "fairground-sealer", "--features", "seal", "--example", "seal_bids", "--", sealedBy.public_key],
    { cwd: root, input: `${plaintexts.join("\n")}\n`, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] },
  );
  const sealed = stdout.trim().split(/\r?\n/);
  if (sealed.length !== plaintexts.length) throw new Error(`expected ${plaintexts.length} boxes from Rust, got ${sealed.length}`);
  sealed.forEach((ciphertext, i) => {
    const opened = sodium.crypto_box_seal_open(
      Buffer.from(ciphertext, "base64"),
      Buffer.from(sealedBy.public_key, "hex"),
      Buffer.from(sealedBy.secret_key, "hex"),
    );
    if (sodium.to_string(opened) !== plaintexts[i]) throw new Error(`Rust box ${i} opened to different bytes`);
  });
  console.log(`libsodium opened all ${sealed.length} Rust-sealed boxes`);
}
