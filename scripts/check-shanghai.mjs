#!/usr/bin/env node
// Fails if any compiled MeterPass contract contains an opcode that Aevum's Shanghai EVM lacks
// (MCOPY, TLOAD, TSTORE, BLOBHASH, BLOBBASEFEE). Walks the bytecode properly, skipping PUSH data.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "contracts", "out");
const BANNED = { 0x5c: "TLOAD", 0x5d: "TSTORE", 0x5e: "MCOPY", 0x49: "BLOBHASH", 0x4a: "BLOBBASEFEE" };
const ONLY = ["PassVault", "AgentIdentityRegistry", "ReputationRegistry", "MeterPassSessionValidator", "MockTUSD8"];

function* artifacts(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* artifacts(p);
    else if (name.endsWith(".json")) yield p;
  }
}

function scan(hex) {
  const code = Buffer.from(hex.replace(/^0x/, ""), "hex");
  const found = [];
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      i += op - 0x5f; // skip PUSH1..PUSH32 data
      continue;
    }
    if (op === 0xfe) break; // INVALID: start of metadata / data section in our builds
    if (BANNED[op]) found.push(`${BANNED[op]}@${i}`);
  }
  return found;
}

let checked = 0;
let bad = 0;
for (const file of artifacts(out)) {
  const name = file.split(/[\\/]/).pop().replace(".json", "");
  if (!ONLY.includes(name)) continue;
  const json = JSON.parse(readFileSync(file, "utf8"));
  for (const kind of ["bytecode", "deployedBytecode"]) {
    const hex = json[kind]?.object;
    if (!hex || hex === "0x") continue;
    const found = scan(hex);
    checked++;
    if (found.length) {
      bad++;
      console.error(`${name} ${kind}: Cancun-only opcodes ${found.slice(0, 5).join(", ")}`);
    }
  }
}
if (checked === 0) {
  console.error("check-shanghai: no artifacts found, run forge build first");
  process.exit(1);
}
if (bad) process.exit(1);
console.log(`check-shanghai: ${checked} bytecode blobs are Shanghai-safe`);
