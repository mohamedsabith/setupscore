import type { SetupFile } from './types.js';

/**
 * A rough token count: about 4 characters per token for English text and code.
 * Good enough to compare setups and spot heavy files, not for billing. Carriage returns are not
 * counted, so a file checked out with CRLF (Windows) costs the same as with LF.
 */
export function estimateTokens(text: string): number {
  let cr = 0;
  for (let i = text.indexOf('\r'); i >= 0; i = text.indexOf('\r', i + 1)) cr++;
  return Math.ceil((text.length - cr) / 4);
}

/** What a file adds to every session before you type anything. */
export function startupTokens(f: SetupFile): number {
  if (f.loadsAtStart) return estimateTokens(f.text);
  if (f.kind === 'skill' || f.kind === 'agent' || f.kind === 'command') {
    // Only the name and description are always loaded; the body loads when used.
    const d = f.frontmatter?.data;
    const name = typeof d?.name === 'string' ? d.name : '';
    const desc = typeof d?.description === 'string' ? d.description : '';
    return name || desc ? estimateTokens(`${name}: ${desc}`) : 0;
  }
  return 0;
}
