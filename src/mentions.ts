// An @ not glued to a word before it, then 1–24 name characters not followed by another name character.
// Linear time: no nested or overlapping quantifiers (adversarial test in tests/mentions.test.ts).
const MENTION = /(?<![A-Za-z0-9_])@([A-Za-z0-9_]{1,24})(?![A-Za-z0-9_])/g;

/** Lower-cased names of members mentioned with @, plus "everyone". Unknown names are ignored; each name appears once. */
export function parseMentions(text: string, memberNames: string[]): string[] {
  const known = new Set(memberNames.map((n) => n.toLowerCase()));
  known.add('everyone');
  const found = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const name = (m[1] ?? '').toLowerCase();
    if (known.has(name)) found.add(name);
  }
  return [...found];
}
