// Pool panel data: one finalized block for price, liquidity and supply; a bounded, chunked Swap scan
// for the trailing 24 hours. A scan with any failed chunk is reported as partial, never as a number.
import type { Abi, Hex, PublicClient } from "viem";
import type { Deployment } from "./deployment";
import { initializeEvent, poolIdOf, priceFromSqrt, stateViewAbi, swapEvent } from "./uniswap";

export const DAY = 86_400n;
export const CHUNK = 5_000n;

export type PoolSnapshot = {
  poolId: Hex;
  block: bigint;
  timestamp: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  totalSupply: bigint;
  /** ETH per whole testAdam, scaled 1e18; 0 when the pool is not initialized at this block. */
  ethPerToken: bigint;
  /** FDV in wei: totalSupply * ethPerToken. */
  fdvWei: bigint;
  initBlock?: bigint;
  volume:
    | { status: "complete"; wei: bigint; swaps: number; fromBlock: bigint; toBlock: bigint; fromTime: bigint; note?: string }
    | { status: "partial"; fromBlock: bigint; toBlock: bigint; scannedTo?: bigint; reason: string };
};

/** Sum |amount0| (or |amount1|) of distinct Swap logs. */
export function sumEthLeg(logs: { transactionHash: Hex | null; logIndex: number | null; args: { amount0?: bigint; amount1?: bigint } }[], ethIsCurrency0: boolean) {
  const seen = new Set<string>();
  let wei = 0n;
  for (const l of logs) {
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = (ethIsCurrency0 ? l.args.amount0 : l.args.amount1) ?? 0n;
    wei += v < 0n ? -v : v;
  }
  return { wei, swaps: seen.size };
}

/** Smallest block number whose timestamp is >= cutoff, searching (lo, hi]. */
export async function firstBlockAtOrAfter(client: PublicClient, cutoff: bigint, hi: bigint): Promise<bigint> {
  let lo = hi > 9_000n ? hi - 9_000n : 0n; // ~30h of 12s blocks
  while ((await client.getBlock({ blockNumber: lo })).timestamp >= cutoff && lo > 0n) lo = lo > 9_000n ? lo - 9_000n : 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await client.getBlock({ blockNumber: mid })).timestamp >= cutoff) hi = mid;
    else lo = mid;
  }
  return hi;
}

async function getLogsRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch {
    return await fn();
  }
}

export async function loadPool(client: PublicClient, d: Deployment): Promise<PoolSnapshot> {
  const k = d.poolKey;
  const poolId = poolIdOf(k);
  const sv = d.network.uniswapV4.stateView;
  const pm = d.network.uniswapV4.poolManager;
  const fin = await client.getBlock({ blockTag: "finalized" });
  const block = fin.number!;
  const [slot0, liquidity, totalSupply] = await Promise.all([
    client.readContract({ address: sv, abi: stateViewAbi, functionName: "getSlot0", args: [poolId], blockNumber: block }),
    client.readContract({ address: sv, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId], blockNumber: block }),
    client.readContract({ address: d.token.address, abi: d.token.abi as Abi, functionName: "totalSupply", blockNumber: block }) as Promise<bigint>,
  ]);
  const sqrtPriceX96 = slot0[0];
  const tokenIsCurrency1 = k.currency1.toLowerCase() === d.token.address.toLowerCase();
  const ethIsCurrency0 = k.currency0 === "0x0000000000000000000000000000000000000000";
  // ETH per testAdam: base = testAdam. Both 18 decimals here, but the formula keeps them explicit.
  const ethPerToken = priceFromSqrt(sqrtPriceX96, { baseIsCurrency0: !tokenIsCurrency1, dec0: 18, dec1: 18 });
  const fdvWei = (totalSupply * ethPerToken) / 10n ** 18n;

  // Initialization block: the first Initialize log for this pool id at or after the contracts' deployment.
  let initBlock: bigint | undefined;
  let initError: string | undefined;
  try {
    const latest = await client.getBlockNumber();
    const tokenBlock = await firstCodeBlock(client, d.token.address, latest);
    for (let from = tokenBlock; from <= latest && initBlock === undefined; from += CHUNK) {
      const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
      const logs = await getLogsRetry(() => client.getLogs({ address: pm, event: initializeEvent, args: { id: poolId }, fromBlock: from, toBlock: to }));
      if (logs.length) initBlock = logs[0].blockNumber!;
    }
  } catch (e) {
    initError = `The pool's initialization block could not be read (${(e as Error).message.slice(0, 80)}).`;
  }
  const base = { poolId, block, timestamp: fin.timestamp, sqrtPriceX96, liquidity, totalSupply, ethPerToken, fdvWei, initBlock };
  if (initError) return { ...base, volume: { status: "partial", fromBlock: block, toBlock: block, reason: initError } };

  const cutoff = fin.timestamp - DAY;
  let volume: PoolSnapshot["volume"];
  if (initBlock === undefined || initBlock > block) {
    volume = { status: "complete", wei: 0n, swaps: 0, fromBlock: block, toBlock: block, fromTime: cutoff, note: initBlock ? `The pool was initialized at block ${initBlock}, after this finalized block, so the window holds no swaps.` : "No Initialize event found for this pool id, so it has no swaps." };
  } else {
    let from: bigint;
    try {
      const cutBlock = await firstBlockAtOrAfter(client, cutoff, block);
      from = cutBlock > initBlock ? cutBlock : initBlock;
    } catch (e) {
      return { poolId, block, timestamp: fin.timestamp, sqrtPriceX96, liquidity, totalSupply, ethPerToken, fdvWei, initBlock, volume: { status: "partial", fromBlock: initBlock, toBlock: block, reason: `Could not locate the block 24 hours back (${(e as Error).message.slice(0, 80)}).` } };
    }
    const all: Parameters<typeof sumEthLeg>[0] = [];
    let failed: string | undefined;
    let scannedTo: bigint | undefined;
    for (let s = from; s <= block; s += CHUNK) {
      const t = s + CHUNK - 1n > block ? block : s + CHUNK - 1n;
      try {
        const logs = await getLogsRetry(() => client.getLogs({ address: pm, event: swapEvent, args: { id: poolId }, fromBlock: s, toBlock: t }));
        all.push(...logs);
        scannedTo = t;
      } catch (e) {
        failed = `Blocks ${s}–${t} did not load (${(e as Error).message.slice(0, 80)}).`;
        break;
      }
    }
    const fromTime = (await client.getBlock({ blockNumber: from })).timestamp;
    if (failed) volume = { status: "partial", fromBlock: from, toBlock: block, scannedTo, reason: failed };
    else volume = { status: "complete", ...sumEthLeg(all, ethIsCurrency0), fromBlock: from, toBlock: block, fromTime };
  }
  return { poolId, block, timestamp: fin.timestamp, sqrtPriceX96, liquidity, totalSupply, ethPerToken, fdvWei, initBlock, volume };
}

/**
 * The block where `address` first has code, by binary search over eth_getCode. The manifest carries no
 * block numbers, and the pool cannot be initialized before its token exists, so this bounds the
 * Initialize search with a fact read from the chain.
 */
export async function firstCodeBlock(client: PublicClient, address: `0x${string}`, hi: bigint): Promise<bigint> {
  const has = async (b: bigint) => ((await client.getCode({ address, blockNumber: b })) ?? "0x") !== "0x";
  if (!(await has(hi))) throw new Error("token has no code at the scan head");
  let lo = 0n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await has(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
