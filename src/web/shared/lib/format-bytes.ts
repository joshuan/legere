const LARGER_UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];

// Byte counts arrive as decimal strings (docs/07 §7.4) because a bucket holds more than a JS number
// counts exactly — so the scaling is done in BigInt and only the last tenth touches a float.
export function formatBytes(bytes: string): string {
  if (!/^\d+$/.test(bytes)) return bytes;

  let value = BigInt(bytes);
  let remainder = 0n;
  let unit = 'B';

  for (const larger of LARGER_UNITS) {
    if (value < 1024n) break;
    remainder = value % 1024n;
    value /= 1024n;
    unit = larger;
  }

  // Bytes are whole things; anything above them reads better with one rounded decimal — and a
  // rounded tenth can carry (1023.98 MB is 1.0 GB, not 0.10 GB).
  if (unit === 'B') return `${value.toString()} B`;
  let tenths = Number((remainder * 10n + 512n) / 1024n);
  if (tenths === 10) {
    value += 1n;
    tenths = 0;
    // And the carry can push a whole unit over, which is how 1023.99 MB becomes 1.0 GB.
    const larger = LARGER_UNITS[LARGER_UNITS.indexOf(unit) + 1];
    if (value === 1024n && larger !== undefined) {
      value = 1n;
      unit = larger;
    }
  }
  return `${value.toString()}.${tenths.toString()} ${unit}`;
}
