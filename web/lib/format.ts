const YOCTO = 10n ** 24n;
const MICRO = 1_000_000n;

export function formatYocto(value: string | bigint): string {
  const raw = typeof value === "bigint" ? value : BigInt(value || "0");
  const whole = raw / YOCTO;
  const frac = (raw % YOCTO).toString().padStart(24, "0").slice(0, 4).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function formatMicro(micro: bigint): string {
  const whole = micro / MICRO;
  const frac = (micro % MICRO).toString().padStart(6, "0").slice(0, 2);
  return `${whole}.${frac}`;
}

export function parseNearToYocto(input: string): bigint | null {
  const text = input.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  if (frac.length > 24) return null;
  return BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, "0"));
}

export function yoctoToNearInput(value: string): string {
  return formatYocto(value);
}
