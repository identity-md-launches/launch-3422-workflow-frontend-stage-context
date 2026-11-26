// Uniswap v4 protocol interfaces (not deployment data). Their addresses come from manifest.network.uniswapV4.
import { encodeAbiParameters, keccak256, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import type { PoolKey } from "./deployment";

const poolKeyComponents = [
  { name: "currency0", type: "address" },
  { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" },
  { name: "hooks", type: "address" },
] as const;

export const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "poolKey", type: "tuple", components: poolKeyComponents },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  { type: "error", name: "NotEnoughLiquidity", inputs: [{ name: "poolId", type: "bytes32" }] },
  { type: "error", name: "UnexpectedRevertBytes", inputs: [{ name: "revertData", type: "bytes" }] },
] as const;

export const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

export const universalRouterAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error TransactionDeadlinePassed()",
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
]);

export const swapEvent = parseAbiItem(
  "event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)",
);
export const initializeEvent = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)",
);

export function poolIdOf(k: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
      [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks],
    ),
  );
}

export const V4_SWAP = "0x10";
export const ACTIONS_EXACT_IN_SINGLE = "0x060c0f"; // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL

/** Build Universal Router execute() args for an exact-input single-pool swap. */
export function encodeExactInSingle(opts: {
  poolKey: PoolKey;
  zeroForOne: boolean;
  amountIn: bigint;
  amountOutMinimum: bigint;
  deadline: bigint;
  extended?: boolean;
}): { commands: Hex; inputs: Hex[]; deadline: bigint } {
  const { poolKey, zeroForOne, amountIn, amountOutMinimum } = opts;
  const keyTuple = { type: "tuple", components: poolKeyComponents } as const;
  const swapParams = opts.extended
    ? encodeAbiParameters(
        [{ type: "tuple", components: [{ name: "poolKey", ...keyTuple }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "minHopPriceX36", type: "uint256" }, { name: "hookData", type: "bytes" }] }],
        [{ poolKey, zeroForOne, amountIn, amountOutMinimum, minHopPriceX36: 0n, hookData: "0x" }],
      )
    : encodeAbiParameters(
        [{ type: "tuple", components: [{ name: "poolKey", ...keyTuple }, { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" }, { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }] }],
        [{ poolKey, zeroForOne, amountIn, amountOutMinimum, hookData: "0x" }],
      );
  const input: Address = zeroForOne ? poolKey.currency0 : poolKey.currency1;
  const output: Address = zeroForOne ? poolKey.currency1 : poolKey.currency0;
  const settle = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [input, amountIn]);
  const take = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [output, amountOutMinimum]);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [ACTIONS_EXACT_IN_SINGLE, [swapParams, settle, take]]);
  return { commands: V4_SWAP, inputs: [v4Input], deadline: opts.deadline };
}

/** Minimum output after slippage, in basis points (50 = 0.5%). Rounds down. */
export function minOut(quoted: bigint, slippageBps: number): bigint {
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

const Q192 = 2n ** 192n;
/**
 * Price of one whole `base` token in whole `quote` tokens, scaled by 10^18, from sqrtPriceX96.
 * sqrtPriceX96^2 / 2^192 is currency1 base units per currency0 base unit.
 */
export function priceFromSqrt(sqrtPriceX96: bigint, opts: { baseIsCurrency0: boolean; dec0: number; dec1: number }): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const sq = sqrtPriceX96 * sqrtPriceX96;
  const S = 10n ** 18n;
  if (opts.baseIsCurrency0) {
    // currency1 per currency0, adjusted to whole units: raw * 10^dec0 / 10^dec1
    return (sq * S * 10n ** BigInt(opts.dec0)) / (Q192 * 10n ** BigInt(opts.dec1));
  }
  // currency0 per currency1
  return (Q192 * S * 10n ** BigInt(opts.dec1)) / (sq * 10n ** BigInt(opts.dec0));
}
