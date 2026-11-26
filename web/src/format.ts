import { formatUnits, parseUnits } from "viem";

/** The visitor's locale. Amount entry and display both use its decimal and grouping separators. */
export const LOCALE: string = (typeof navigator !== "undefined" && navigator.language) || "en-US";

const SPACES = /[\s\u00a0\u202f]/g;
const HAS_SPACE = /[\s\u00a0\u202f]/;

/** Decimal and grouping separators of a locale. Space-like group separators are reported as " ". */
export function separators(locale = LOCALE): { decimal: string; group: string } {
  let decimal = ".";
  let group = ",";
  try {
    for (const p of new Intl.NumberFormat(locale, { useGrouping: true }).formatToParts(12345.6)) {
      if (p.type === "decimal") decimal = p.value;
      if (p.type === "group") group = p.value.replace(SPACES, " ");
    }
  } catch {
    /* unknown locale: keep the defaults */
  }
  return { decimal, group };
}

/** Group digits and keep at most `max` decimals, rounding down so a balance is never overstated. */
export function fmt(value: bigint | undefined, decimals = 18, max = 4, locale = LOCALE): string {
  if (value === undefined) return "…";
  const { decimal, group } = separators(locale);
  const neg = value < 0n;
  const s = formatUnits(neg ? -value : value, decimals);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, max).replace(/0+$/, "");
  const g = group === " " ? " " : group;
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, g);
  const out = frac ? `${int}${decimal}${frac}` : int;
  if (out === "0" && value !== 0n) return `${neg ? "> -" : "< "}0${decimal}${"0".repeat(Math.max(0, max - 1))}1`;
  return neg ? `-${out}` : out;
}

/** A value written the way the amount field accepts it: locale decimal separator, no grouping, every decimal kept. */
export function fmtInput(value: bigint, decimals = 18, locale = LOCALE): string {
  const s = formatUnits(value, decimals);
  return s.replace(".", separators(locale).decimal);
}

/** An example amount such as "1.5" written with the locale's decimal separator ("1,5" in French). */
export function example(plain: string, locale = LOCALE): string {
  return plain.replace(".", separators(locale).decimal);
}

/**
 * Parse a typed amount in the visitor's locale. Returns undefined for empty, invalid, too many decimals or
 * non-positive input. One decimal separator is accepted. Grouping is accepted only in valid groups of three
 * and is removed once, after validation. A "." is also read as the decimal point in locales that use it for
 * neither role (French "0.01" is 0.01); where "." groups digits (German), "0.01" is rejected, never multiplied.
 */
export function parseAmount(text: string, decimals = 18, locale = LOCALE): bigint | undefined {
  const { decimal, group } = separators(locale);
  let t = text.trim();
  if (t === "") return undefined;
  if (group === " ") t = t.replace(SPACES, " ");
  else if (HAS_SPACE.test(t)) return undefined;
  let dec = decimal;
  if (!t.includes(decimal) && t.includes(".") && group !== "." && decimal !== ".") dec = ".";
  const parts = t.split(dec);
  if (parts.length > 2) return undefined;
  const [intRaw, frac = ""] = parts;
  if (!/^\d*$/.test(frac)) return undefined;
  let int = intRaw;
  if (group && int.includes(group)) {
    const esc = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`^\\d{1,3}(${esc}\\d{3})+$`).test(int)) return undefined;
    int = int.split(group).join("");
  }
  if (!/^\d*$/.test(int)) return undefined;
  if (int === "" && frac === "") return undefined;
  if (frac.length > decimals) return undefined;
  try {
    const v = parseUnits(`${int || "0"}.${frac || "0"}`, decimals);
    return v > 0n ? v : undefined;
  } catch {
    return undefined;
  }
}

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function utc(ts: bigint | number): string {
  return new Date(Number(ts) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}
