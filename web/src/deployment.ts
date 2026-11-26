// The single runtime configuration: ./imd-deployment.json (emitted next to index.html at build time)
// and the ABI files it references. Addresses, chain id, public RPCs, Uniswap v4 addresses and the
// pool key are read from it and nowhere else.
import type { Abi, Address, Chain } from "viem";
import { defineChain, getAddress } from "viem";

export type PoolKey = { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
export type Network = {
  chainId: number;
  name: string;
  testnet: boolean;
  rpcUrls: string[];
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  faucets?: string[];
  uniswapV4: { poolManager: Address; universalRouter: Address; quoter: Address; stateView: Address; positionManager: Address; permit2: Address; extendedSwapParams?: boolean };
};
export type WalletAddChain = { chainId: string; chainName: string; rpcUrls: string[]; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrls: string[] };
export type Manifest = {
  version: 1;
  launchId: string;
  chainId: number;
  sourceCommit: string;
  attestationHash: string;
  contracts: { name: string; address: Address; abiHash: string; abiPath: string }[];
  assets: { path: string; sha256: string }[];
  poolKey: PoolKey;
  network: Network;
  walletAddChain?: WalletAddChain;
};
export type Contract = { name: string; address: Address; abi: Abi; abiHash: string };
export type Deployment = {
  manifest: Manifest;
  chain: Chain;
  network: Network;
  walletAddChain?: WalletAddChain;
  poolKey: PoolKey;
  token: Contract;
  vault: Contract;
  /** Lowest deployment block among the contracts is not in the manifest; the pool scan finds Initialize itself. */
};

export const SITE = {
  name: "test staking",
  description: "Give testAdam as public gifts, earn permanent donor points, and buy testAdam with Sepolia ETH.",
};

export function chainFromNetwork(n: Network): Chain {
  return defineChain({
    id: n.chainId,
    name: n.name,
    nativeCurrency: n.nativeCurrency,
    rpcUrls: { default: { http: n.rpcUrls } },
    blockExplorers: { default: { name: "Explorer", url: n.explorer } },
    testnet: n.testnet,
  });
}

function rel(path: string) {
  if (/^[a-z]+:|^\/|\.\./i.test(path)) throw new Error(`Refusing non-relative path ${path}`);
  return new URL(path, document.baseURI).toString();
}

export function parseManifest(m: Manifest, abis: Record<string, Abi>): Deployment {
  if (m.version !== 1) throw new Error("Unsupported deployment manifest version");
  if (!m.network || m.network.chainId !== m.chainId) throw new Error("Deployment network does not match its chain id");
  if (!m.poolKey) throw new Error("Deployment manifest has no pool key");
  const find = (name: string): Contract => {
    const c = m.contracts.find((x) => x.name === name);
    if (!c) throw new Error(`Deployment manifest is missing ${name}`);
    const abi = abis[c.abiPath];
    if (!abi) throw new Error(`ABI for ${name} did not load`);
    return { name, address: getAddress(c.address), abi, abiHash: c.abiHash };
  };
  return {
    manifest: m,
    chain: chainFromNetwork(m.network),
    network: m.network,
    walletAddChain: m.walletAddChain,
    poolKey: m.poolKey,
    token: find("LaunchToken"),
    vault: find("DonationVault"),
  };
}

export async function loadDeployment(): Promise<Deployment> {
  const res = await fetch(rel("imd-deployment.json"), { cache: "no-cache" });
  if (!res.ok) throw new Error(`imd-deployment.json did not load (HTTP ${res.status})`);
  const m = (await res.json()) as Manifest;
  const abis: Record<string, Abi> = {};
  await Promise.all(
    m.contracts.map(async (c) => {
      const r = await fetch(rel(c.abiPath));
      if (!r.ok) throw new Error(`${c.abiPath} did not load (HTTP ${r.status})`);
      abis[c.abiPath] = (await r.json()) as Abi;
    }),
  );
  return parseManifest(m, abis);
}
