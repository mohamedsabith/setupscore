/**
 * Test names from `test('...')` and `it("...")` calls, including .only and .concurrent.
 * A regular expression is good enough for acceptance criteria; skipped and todo tests are left out.
 * A name ends at the end of its line, so an unclosed quote cannot make the search scan the rest
 * of the file again for every test call (slow on huge generated test files).
 */
const TEST_CALL = /\b(?:test|it)(?:\.(?:only|concurrent|failing))?\s*\(\s*(['"`])((?:\\[^\n]|(?!\1)[^\\\n])*?)\1/g;

export function testNames(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(TEST_CALL)) {
    const name = m[2]!
      .replace(/\\(['"`\\])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (name && !name.includes('${')) names.add(name);
  }
  return [...names];
}

/** Names present after the change but not before. */
export function newTestNames(before: string | null, after: string): string[] {
  const old = new Set(before ? testNames(before) : []);
  return testNames(after).filter((n) => !old.has(n));
}
