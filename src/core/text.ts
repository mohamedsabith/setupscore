/**
 * `s` without the characters at its end for which `drop` is true. The same result as
 * `s.replace(/[...]+$/, '')`, in linear time: that regex is quadratic on a long run of such
 * characters followed by another one (a ReDoS a crafted file could trigger).
 */
export function trimEndWhile(s: string, drop: (ch: string) => boolean): string {
  let end = s.length;
  while (end > 0 && drop(s[end - 1]!)) end--;
  return end === s.length ? s : s.slice(0, end);
}
