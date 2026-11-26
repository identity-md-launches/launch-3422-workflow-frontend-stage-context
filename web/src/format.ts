import { formatUnits, parseUnits } from "viem";

/** Group digits and keep at most `max` decimals, rounding down so a balance is never overstated. */
export function fmt(value: bigint | undefined, decimals = 18, max = 4): string {
  if (value === undefined) return "…";
  const neg = value < 0n;
  const s = formatUnits(neg ? -value : value, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const out = frac ? `${int}.${frac}` : int;
  if (out === "0" && value !== 0n) return `${neg ? "> -" : "< "}0.${"0".repeat(Math.max(0, max - 1))}1`;
  return neg ? `-${out}` : out;
}

/** Parse a typed amount. Returns undefined for empty, invalid, too many decimals, or non-positive input. */
export function parseAmount(text: string, decimals = 18): bigint | undefined {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d*\.?\d*$/.test(t) || t === "" || t === ".") return undefined;
  const [, f = ""] = t.split(".");
  if (f.length > decimals) return undefined;
  try {
    const v = parseUnits(t, decimals);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function utc(ts: bigint | number): string {
  return new Date(Number(ts) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
