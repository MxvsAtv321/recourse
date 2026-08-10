/** Every value here is derived from the captured run. Nothing is invented. */

export function money(baseUnits: string, decimals: number): string {
  const n = BigInt(baseUnits);
  const d = BigInt(10) ** BigInt(decimals);
  const whole = n / d;
  const frac = (n % d).toString().padStart(decimals, "0").slice(0, 2);
  return `${whole.toLocaleString("en-US")}.${frac}`;
}

export function shortHash(h: string, lead = 10, tail = 6): string {
  return h.length <= lead + tail + 2 ? h : `${h.slice(0, lead)}…${h.slice(-tail)}`;
}

export function stamp(unixSeconds: string): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  });
}

export function duration(seconds: string): string {
  const s = Number(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const h = s / 3600;
  return h < 10 ? `${h.toFixed(1)} hours` : `${Math.round(h)} hours`;
}

export const pct = (part: number, whole: number) => `${Math.round((part / whole) * 100)}%`;
