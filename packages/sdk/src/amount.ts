import { formatUnits, parseUnits } from "viem";

/** tUSD8 has 6 decimals. */
export const TUSD8_DECIMALS = 6;

export const toUnits = (amount: string | number) => parseUnits(String(amount), TUSD8_DECIMALS);

/** 1234567n -> "1.234567" (trailing zeros trimmed, at least 2 decimals). */
export function formatTusd8(units: bigint, minDecimals = 2): string {
  const s = formatUnits(units, TUSD8_DECIMALS);
  const [whole, frac = ""] = s.split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(minDecimals, "0");
  return `${whole}.${trimmed}`;
}
