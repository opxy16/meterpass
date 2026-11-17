#!/usr/bin/env node
// Pre-commit guard: refuses a commit if a staged file is an env file, or an added line contains
// one of our wallet keys or anything shaped like a private-key / mnemonic assignment.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const git = (args) => execSync(`git ${args}`, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const staged = git("diff --cached --name-only --diff-filter=ACMR").split(/\r?\n/).filter(Boolean);
const diff = git("diff --cached -U0 --no-color --no-ext-diff --diff-filter=ACMR");

const knownKeys = new Set();
const envPath = join(root, ".env.wallets");
if (existsSync(envPath)) {
  for (const m of readFileSync(envPath, "utf8").matchAll(/_PRIVATE_KEY=0x([0-9a-fA-F]{64})/g)) knownKeys.add(m[1].toLowerCase());
}
// anvil's well-known PUBLIC test keys are fine in tests and docs
const anvilKeys = [
  "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const keyAssign = /(PRIVATE_KEY|PRIV_KEY|SECRET_KEY|MNEMONIC|SEED_PHRASE)["']?\s*[:=]\s*["']?(0x)?[0-9a-fA-F]{64}/i;
const mnemonicLike = /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/;

const problems = new Set();
for (const file of staged) {
  const base = file.split("/").pop();
  if (/^\.env(\..*)?$/.test(base) && !base.endsWith(".example")) problems.add(`${file}: env files must not be committed`);
}
let file = "";
for (const line of diff.split(/\r?\n/)) {
  if (line.startsWith("+++ ")) {
    file = line.replace(/^\+\+\+ (b\/)?/, "");
    continue;
  }
  if (!line.startsWith("+")) continue;
  const text = line.slice(1);
  for (const m of text.matchAll(/(?:0x)?([0-9a-fA-F]{64})/g)) {
    if (knownKeys.has(m[1].toLowerCase())) problems.add(`${file}: contains a key from .env.wallets`);
  }
  if (keyAssign.test(text) && !anvilKeys.some((k) => text.toLowerCase().includes(k))) {
    problems.add(`${file}: looks like a private key assignment`);
  }
  if (/mnemonic|seed/i.test(text) && mnemonicLike.test(text) && !text.includes("test test test")) problems.add(`${file}: looks like a seed phrase`);
}

if (problems.size) {
  console.error("check-secrets: commit blocked\n  " + [...problems].join("\n  "));
  process.exit(1);
}
console.log(`check-secrets: ${staged.length} staged file(s) clean`);
