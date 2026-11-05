// Splits the action's `args` input into words the way a shell would, but never expands anything:
// no globs, no $VARIABLES, no $(commands) or `commands`, no ~. Used by action.yml.
//
//   - spaces, tabs and newlines separate words
//   - 'single quotes' keep everything inside as it is
//   - "double quotes" keep everything inside; only \" \\ \$ and \` drop their backslash
//   - outside quotes, a backslash keeps the next character as it is
//
// Reads SETUPSCORE_ARGS from the environment (never from the command line, so no shell touches it)
// and writes every word followed by a NUL byte. Exits 2 with a message if a quote is not closed.

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function splitArgs(text) {
  const words = [];
  let word = '';
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (WHITESPACE.has(c)) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new Error("a single quote (') is not closed");
      word += text.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= text.length) throw new Error('a double quote (") is not closed');
        const d = text[j];
        if (d === '"') break;
        if (d === '\\' && j + 1 < text.length && '"\\$`\n'.includes(text[j + 1])) {
          if (text[j + 1] !== '\n') word += text[j + 1]; // backslash + newline continues the line
          j += 2;
        } else {
          word += d;
          j += 1;
        }
      }
      inWord = true;
      i = j;
    } else if (c === '\\') {
      if (i + 1 >= text.length) {
        word += c; // a backslash at the very end is kept
        inWord = true;
      } else if (text[i + 1] === '\n') {
        i += 1; // backslash + newline continues the line
      } else {
        word += text[i + 1];
        inWord = true;
        i += 1;
      }
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return words;
}

try {
  const words = splitArgs(process.env.SETUPSCORE_ARGS ?? '');
  process.stdout.write(words.map((w) => `${w}\0`).join(''));
} catch (err) {
  process.stderr.write(
    `The args input could not be split into words: ${err.message}. Quote values the way you would in a shell, for example --setup-b "my branch".\n`,
  );
  process.exit(2);
}
