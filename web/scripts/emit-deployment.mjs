// Runs after `vite build`: copies the implementation-derived ABIs into dist/abi/, verifies each
// against the handoff's abiHash, and writes dist/imd-deployment.json listing every other exported
// file with its SHA-256. The app loads that same file at runtime.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalKeccak } from "./abi-hash.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const root = resolve(web, "..");
const dist = join(root, "dist");
const handoff = JSON.parse(readFileSync(join(web, "deployment/handoff.json"), "utf8"));
const networkFile = JSON.parse(readFileSync(join(web, "deployment/network.json"), "utf8"));
const MAX_FILE = 8 * 1024 * 1024;

mkdirSync(join(dist, "abi"), { recursive: true });
const contracts = handoff.contracts.map((c) => {
  const src = join(root, "docs/abi", `${c.name}.json`);
  const bytes = readFileSync(src);
  const abi = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(abi)) throw new Error(`${src} is not a raw ABI array`);
  const h = canonicalKeccak(abi);
  if (h !== c.abiHash) throw new Error(`${c.name} ABI hash ${h} does not match handoff ${c.abiHash}`);
  const abiPath = `abi/${c.name}.json`;
  writeFileSync(join(dist, abiPath), bytes);
  return { name: c.name, address: c.address, abiHash: c.abiHash, abiPath };
});

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const assets = walk(dist)
  .map((p) => relative(dist, p).split(sep).join("/"))
  .filter((p) => p !== "imd-deployment.json")
  .sort()
  .map((path) => {
    const bytes = readFileSync(join(dist, path));
    if (bytes.length > MAX_FILE) throw new Error(`${path} exceeds 8 MiB`);
    return { path, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
if (assets.length > 128) throw new Error(`${assets.length} assets exceed the 128 limit`);
if (!assets.some((a) => a.path === "index.html")) throw new Error("dist/index.html missing");

const manifest = {
  version: 1,
  launchId: handoff.launchId,
  chainId: handoff.chainId,
  sourceCommit: handoff.sourceCommit,
  attestationHash: handoff.attestationHash,
  contracts,
  assets,
  ...(handoff.poolKey ? { poolKey: handoff.poolKey } : {}),
  ...(networkFile.network ? { network: networkFile.network } : {}),
  ...(networkFile.walletAddChain ? { walletAddChain: networkFile.walletAddChain } : {}),
};
writeFileSync(join(dist, "imd-deployment.json"), `${JSON.stringify(manifest, null, 2)}\n`);
const total = assets.reduce((s, a) => s + statSync(join(dist, a.path)).size, 0);
console.log(`imd-deployment.json: ${contracts.length} contracts, ${assets.length} assets, ${total} bytes`);
