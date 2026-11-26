// Canonical ABI hash: keccak256 of the ABI JSON re-serialized with object keys sorted and no whitespace.
import { keccak256, toHex } from "viem";
export function canonicalJson(v) {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export const canonicalKeccak = (abi) => keccak256(toHex(canonicalJson(abi))).slice(2);
