const HOMOGLYPHS: Record<string, string> = {
  "0": "o",
  "1": "l",
  i: "l",
  l: "l",
  rn: "m",
  vv: "w",
};

/** Normalise separators and homoglyphs for comparison. */
export function normaliseAccountId(id: string): string {
  let s = id.toLowerCase();
  s = s.replace(/[-_.]+/g, ".");
  s = s.replace(/0/g, "o").replace(/1/g, "l");
  s = s.replace(/vv/g, "w").replace(/rn/g, "m");
  for (const [from, to] of Object.entries(HOMOGLYPHS)) {
    if (from.length === 1 && from !== "0" && from !== "1") {
      s = s.split(from).join(to);
    }
  }
  return s;
}

function damerauLevenshtein(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  const max = lenA + lenB;
  const da: Record<string, number> = {};
  const d = Array.from({ length: lenA + 2 }, () => new Array<number>(lenB + 2).fill(0));
  d[0]![0] = max;
  for (let i = 0; i <= lenA; i++) {
    d[i + 1]![0] = max;
    d[i + 1]![1] = i;
  }
  for (let j = 0; j <= lenB; j++) {
    d[0]![j + 1] = max;
    d[1]![j + 1] = j;
  }
  for (let i = 1; i <= lenA; i++) {
    let db = 0;
    for (let j = 1; j <= lenB; j++) {
      const i1 = da[b[j - 1]!] ?? 0;
      const j1 = db;
      let cost = 1;
      if (a[i - 1] === b[j - 1]) {
        cost = 0;
        db = j;
      }
      d[i + 1]![j + 1] = Math.min(
        d[i]![j + 1]! + 1,
        d[i + 1]![j]! + 1,
        d[i]![j]! + cost,
        d[i1]![j1]! + (i - i1 - 1) + 1 + (j - j1 - 1),
      );
    }
    da[a[i - 1]!] = i;
  }
  return d[lenA + 1]![lenB + 1]!;
}

export interface LookalikeMatch {
  target: string;
  distance: number;
  normalisedMatch: boolean;
}

export function findLookalike(
  receiver: string,
  trustedIds: string[],
): LookalikeMatch | null {
  if (receiver.length < 6) return null;
  const rn = normaliseAccountId(receiver);
  for (const target of trustedIds) {
    if (target === receiver) continue;
    if (target.length < 6) continue;
    const tn = normaliseAccountId(target);
    if (tn === rn) {
      return { target, distance: 0, normalisedMatch: true };
    }
    const dist = damerauLevenshtein(rn, tn);
    if (dist <= 2) {
      return { target, distance: dist, normalisedMatch: false };
    }
  }
  return null;
}
