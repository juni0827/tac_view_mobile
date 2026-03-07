export type AltitudeBand = 'cruise' | 'high' | 'mid' | 'low' | 'ground';

export function getAltitudeBand(altFeet: number): AltitudeBand {
  if (altFeet >= 35_000) return 'cruise';
  if (altFeet >= 20_000) return 'high';
  if (altFeet >= 10_000) return 'mid';
  if (altFeet >= 3_000) return 'low';
  return 'ground';
}
