import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, parseEther } from "viem";
import handoff from "../deployment/handoff.json";
import { encodeExactInSingle, minOut, poolIdOf, priceFromSqrt, universalRouterAbi } from "./uniswap";
import { fmt, parseAmount } from "./format";
import { sumEthLeg } from "./pool";
import type { PoolKey } from "./deployment";

const key = handoff.poolKey as PoolKey;

describe("amounts", () => {
  it("parses fractional input with 18 decimals", () => {
    expect(parseAmount("1.5")).toBe(1_500_000_000_000_000_000n);
    expect(parseAmount("0")).toBeUndefined();
    expect(parseAmount("abc")).toBeUndefined();
    expect(parseAmount("1." + "1".repeat(19))).toBeUndefined();
    expect(parseAmount("1,000")).toBe(parseEther("1000"));
  });
  it("formats without overstating", () => {
    expect(fmt(1_999_999_999_999_999_999n)).toBe("1.9999");
    expect(fmt(10n ** 27n)).toBe("1,000,000,000");
    expect(fmt(1n)).toBe("< 0.0001");
  });
});

describe("pool math", () => {
  it("pool id matches the one computed on chain for the handoff key", () => {
    expect(poolIdOf(key)).toBe("0xf6b590d823083d9a9b7c10ceb9a990d06b9a1196e6a2dc002a1b1b915393d394");
  });
  it("converts sqrtPriceX96 using currency order", () => {
    const q96 = 2n ** 96n;
    // price 1:1
    expect(priceFromSqrt(q96, { baseIsCurrency0: true, dec0: 18, dec1: 18 })).toBe(10n ** 18n);
    // sqrt = 2*Q96 -> currency1 per currency0 = 4; currency0 per currency1 = 0.25
    expect(priceFromSqrt(2n * q96, { baseIsCurrency0: true, dec0: 18, dec1: 18 })).toBe(4n * 10n ** 18n);
    expect(priceFromSqrt(2n * q96, { baseIsCurrency0: false, dec0: 18, dec1: 18 })).toBe(25n * 10n ** 16n);
    expect(priceFromSqrt(0n, { baseIsCurrency0: false, dec0: 18, dec1: 18 })).toBe(0n);
  });
  it("sums the absolute ETH leg of distinct swaps", () => {
    const logs = [
      { transactionHash: "0x01" as const, logIndex: 0, args: { amount0: -5n, amount1: 9n } },
      { transactionHash: "0x01" as const, logIndex: 0, args: { amount0: -5n, amount1: 9n } },
      { transactionHash: "0x02" as const, logIndex: 3, args: { amount0: 7n, amount1: -2n } },
    ];
    expect(sumEthLeg(logs, true)).toEqual({ wei: 12n, swaps: 2 });
  });
});

describe("swap encoding", () => {
  it("applies slippage rounding down", () => {
    expect(minOut(10_000n, 100)).toBe(9_900n);
    expect(minOut(999n, 50)).toBe(994n);
  });
  it("encodes V4_SWAP with SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL", () => {
    const { commands, inputs, deadline } = encodeExactInSingle({ poolKey: key, zeroForOne: true, amountIn: 10n ** 16n, amountOutMinimum: 123n, deadline: 999n });
    expect(commands).toBe("0x10");
    const data = encodeFunctionData({ abi: universalRouterAbi, functionName: "execute", args: [commands, inputs, deadline] });
    const dec = decodeFunctionData({ abi: universalRouterAbi, data });
    expect(dec.functionName).toBe("execute");
    const [actions, params] = decodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], inputs[0]);
    expect(actions).toBe("0x060c0f");
    expect(params).toHaveLength(3);
    const [swap] = decodeAbiParameters(
      [{ type: "tuple", components: [{ name: "poolKey", type: "tuple", components: [{ name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }] }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
      params[0],
    );
    expect(swap.poolKey.hooks.toLowerCase()).toBe(key.hooks);
    expect(swap.poolKey.fee).toBe(12500);
    expect(swap.zeroForOne).toBe(true);
    expect(swap.amountIn).toBe(10n ** 16n);
    expect(swap.amountOutMinimum).toBe(123n);
    const [cur, amt] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[1]);
    expect(cur).toBe("0x0000000000000000000000000000000000000000");
    expect(amt).toBe(10n ** 16n);
    const [out, min] = decodeAbiParameters([{ type: "address" }, { type: "uint256" }], params[2]);
    expect(out.toLowerCase()).toBe(key.currency1);
    expect(min).toBe(123n);
  });
});
