// Bundles the public deployment, evidence and metrics JSON from /deployments into the web app.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "..", "deployments");
const out = join(here, "..", "src", "generated");
mkdirSync(out, { recursive: true });

const deployments = {};
const evidence = {};
const metrics = {};
if (existsSync(src)) {
  for (const f of readdirSync(src)) {
    const m = f.match(/^(evidence-|metrics-)?(\d+)\.json$/);
    if (!m) continue;
    const data = JSON.parse(readFileSync(join(src, f), "utf8"));
    if (m[1] === "evidence-") evidence[m[2]] = data;
    else if (m[1] === "metrics-") metrics[m[2]] = data;
    else deployments[m[2]] = data;
  }
}
writeFileSync(join(out, "deployments.json"), JSON.stringify(deployments, null, 2));
writeFileSync(join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
writeFileSync(join(out, "metrics.json"), JSON.stringify(metrics, null, 2));
console.log(`copied deployments for chains: ${Object.keys(deployments).join(", ") || "(none yet)"}`);
