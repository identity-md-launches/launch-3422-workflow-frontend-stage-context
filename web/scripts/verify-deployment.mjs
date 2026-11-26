// Checks dist/imd-deployment.json against the handoff, network table, ABI hashes and exported bytes.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalKeccak } from "./abi-hash.mjs";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(web, "../dist");
const m = JSON.parse(readFileSync(join(dist, "imd-deployment.json"), "utf8"));
const h = JSON.parse(readFileSync(join(web, "deployment/handoff.json"), "utf8"));
const n = JSON.parse(readFileSync(join(web, "deployment/network.json"), "utf8"));
const errors = [];
const eq = (a, b, what) => JSON.stringify(a) !== JSON.stringify(b) && errors.push(`${what} differs`);
const allowed = ["version", "launchId", "chainId", "sourceCommit", "attestationHash", "contracts", "assets", "poolKey", "network", "walletAddChain"];
for (const k of Object.keys(m)) if (!allowed.includes(k)) errors.push(`extra top-level key ${k}`);
if (m.version !== 1) errors.push("version");
for (const k of ["launchId", "chainId", "sourceCommit", "attestationHash", "poolKey"]) eq(m[k], h[k], k);
eq(m.network, n.network, "network");
eq(m.walletAddChain, n.walletAddChain, "walletAddChain");
eq(m.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash })), h.contracts.map(({ name, address, abiHash }) => ({ name, address, abiHash })), "contracts");
const safe = (p) => !/^[a-z]+:|^\/|(^|\/)\.\.(\/|$)/i.test(p);
for (const c of m.contracts) {
  if (!safe(c.abiPath)) errors.push(`unsafe abiPath ${c.abiPath}`);
  const abi = JSON.parse(readFileSync(join(dist, c.abiPath), "utf8"));
  if (canonicalKeccak(abi) !== c.abiHash) errors.push(`${c.name} abi hash`);
  if (!m.assets.some((a) => a.path === c.abiPath)) errors.push(`${c.abiPath} not listed`);
}
const walk = (d) => readdirSync(d).flatMap((x) => (statSync(join(d, x)).isDirectory() ? walk(join(d, x)) : [join(d, x)]));
const files = walk(dist).map((p) => relative(dist, p).split(sep).join("/")).filter((p) => p !== "imd-deployment.json");
let total = 0;
for (const f of files) {
  const a = m.assets.find((x) => x.path === f);
  const bytes = readFileSync(join(dist, f));
  total += bytes.length;
  if (!a) errors.push(`unlisted file ${f}`);
  else if (a.sha256 !== createHash("sha256").update(bytes).digest("hex")) errors.push(`hash mismatch ${f}`);
  if (bytes.length > 8 * 1024 * 1024) errors.push(`${f} over 8 MiB`);
}
for (const a of m.assets) {
  if (!safe(a.path)) errors.push(`unsafe asset path ${a.path}`);
  if (!/^[0-9a-f]{64}$/.test(a.sha256)) errors.push(`bad hash format ${a.path}`);
  if (!files.includes(a.path)) errors.push(`listed but missing ${a.path}`);
}
if (m.assets.length > 128) errors.push("more than 128 assets");
if (!files.includes("index.html")) errors.push("index.html missing");
const html = readFileSync(join(dist, "index.html"), "utf8");
if (/(src|href)="\/(?!\/)/.test(html)) errors.push("index.html has root-absolute asset paths");
console.log(JSON.stringify({ ok: errors.length === 0, assets: m.assets.length, totalBytes: total, errors }, null, 2));
process.exit(errors.length ? 1 : 0);
