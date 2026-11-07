export interface SecretMatch {
  what: string;
  value: string;
  index: number;
}

/** Well-known key formats. Each is specific enough to have very few false alarms. */
const KNOWN: [RegExp, string][] = [
  [/\bsk-ant-[A-Za-z0-9_-]{20,}/g, 'an Anthropic API key'],
  [/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g, 'an OpenAI-style API key'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, 'an AWS access key'],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, 'a GitHub token'],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, 'a GitHub token'],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/g, 'a GitLab token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'a Slack token'],
  [/\bhttps:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{16,}/g, 'a Slack webhook URL'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, 'a Google API key'],
  [/\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}\b/g, 'a Stripe secret key'],
  [/\bnpm_[A-Za-z0-9]{36}\b/g, 'an npm token'],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, 'a SendGrid API key'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, 'a JWT (a signed login token)'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g, 'a private key'],
];

/**
 * `name = value` or `name: value` where the name ends in password, secret, token or key:
 * password=..., DB_PASSWORD=..., aws_secret_access_key = ..., "apiKey": "...".
 * The name must start a word (no letter, digit, `_` or `-` before it) so each name is read once.
 */
const ASSIGNED =
  /(?<![A-Za-z0-9_-])((?:[A-Za-z0-9]+[_-])*?(password|passwd|pwd|secret|client[_-]?secret|token|auth[_-]?token|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key))(?![A-Za-z0-9])["']?[ \t]*[:=][ \t]*["']?([^\s"'`,;)]{6,})/gi;

/** A password in a URL: scheme://user:password@host */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]{1,20}:\/\/([^\s:@/"'`<>]{1,100}):([^\s@/"'`<>]{1,200})@[\w.-]/gi;

/** Values that are clearly placeholders, variables or code, not real secrets. */
const NOT_A_SECRET =
  /^(?:\$|%[A-Za-z_]|<|\{\{|\[|\*|•|x{3,}|\.{3}|…|your|my[_-]?|change[_-]?me|example|sample|dummy|fake|test|placeholder|redacted|secret$|password$|token$|none$|null$|undefined$|true$|false$|string$|number$|boolean$|bigint$|object$|any$|unknown$|required$|optional$|process\.env|os\.environ|os\.getenv|env\.|env\[|import\.meta|settings\.|config\.|secrets\.|vars\.|\.{0,2}\/|~\/|pk_(?:live|test)_)/i;

/** Type annotations and declarations in code: `apiKey: string;`, `token?: string`. */
const TYPE_NAME =
  /^(?:string|number|boolean|bigint|object|any|unknown|never|void|null|undefined|str|int|bool|bytes|String|Option<|Optional\[|Secret\b)/;

/** A path to a file, not a secret: config/secret.json, certs/server.key */
const FILE_PATH =
  /^[\w.@~-]*(?:\/[\w.@~-]+)*\.(?:json|ya?ml|toml|txt|pem|key|crt|cer|p12|pfx|env|ini|cfg|conf|ts|js|mjs|cjs|py|rb|go|md|sh)$/i;

/** Placeholder text inside a value that otherwise looks real: AKIAIOSFODNN7EXAMPLE, sk-ant-xxxxxxxx… */
const PLACEHOLDER_INSIDE = /EXAMPLE|x{5,}|X{5,}|\.{3}|…|0{8,}|<[^<>]*>|\$\{|\{\{/;

/** The well-known signature of the example JWT on jwt.io. */
const JWT_IO_EXAMPLE = 'SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';

/** True when a value is obviously not a real secret: a variable, a placeholder, a type or a path. */
export function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v === '' || NOT_A_SECRET.test(v) || TYPE_NAME.test(v) || FILE_PATH.test(v)) return true;
  if (PLACEHOLDER_INSIDE.test(v) || v.includes(JWT_IO_EXAMPLE)) return true;
  if (/^(.)\1+$/.test(v)) return true; // ******** or aaaaaaaa
  // The part after a known prefix is all one character: ghp_xxxx…, sk-ant-0000…
  const body = v.replace(
    /^(?:sk-ant-|sk-|gh[pousr]_|github_pat_|glpat-|xox[abposr]-|npm_|AKIA|ASIA|AIza|(?:sk|rk)_(?:live|test)_)/,
    '',
  );
  return body !== v && /^(.)\1+$/i.test(body);
}

const article = (word: string): string => (/^[aeiou]/i.test(word) ? 'an' : 'a');

/** "a password", "an API key", "a secret access key": what kind of secret a name holds. */
function describeName(keyword: string): string {
  const k = keyword.toLowerCase().replace(/[_-]/g, '');
  const words: Record<string, string> = {
    password: 'password',
    passwd: 'password',
    pwd: 'password',
    secret: 'secret',
    clientsecret: 'client secret',
    token: 'token',
    authtoken: 'auth token',
    accesstoken: 'access token',
    refreshtoken: 'refresh token',
    apikey: 'API key',
    accesskey: 'access key',
    secretkey: 'secret key',
    privatekey: 'private key',
  };
  const w = words[k] ?? 'secret';
  return `${article(w)} ${w}`;
}

export function findSecrets(text: string): SecretMatch[] {
  const found: SecretMatch[] = [];
  const taken: [number, number][] = [];
  const overlaps = (s: number, e: number) => taken.some(([a, b]) => s < b && e > a);

  for (const [re, what] of KNOWN) {
    for (const m of text.matchAll(re)) {
      if (what !== 'a private key' && isPlaceholder(m[0])) continue;
      found.push({ what, value: m[0], index: m.index! });
      taken.push([m.index!, m.index! + m[0].length]);
    }
  }
  for (const m of text.matchAll(URL_PASSWORD)) {
    const user = m[1]!;
    const value = m[2]!;
    const index = m.index! + m[0].indexOf(`:${value}@`) + 1;
    if (value.length < 6 || value === user || isPlaceholder(value) || overlaps(index, index + value.length)) continue;
    if (/^(?:pass(?:word)?|secret|postgres|root|admin|guest|pw)$/i.test(value)) continue;
    found.push({ what: 'a password in a URL', value, index });
    taken.push([index, index + value.length]);
  }
  for (const m of text.matchAll(ASSIGNED)) {
    const value = m[3]!;
    const index = m.index! + m[0].length - value.length;
    if (isPlaceholder(value) || overlaps(index, index + value.length)) continue;
    found.push({ what: describeName(m[2]!), value, index });
    taken.push([index, index + value.length]);
  }
  return found.sort((a, b) => a.index - b.index);
}

/** Show just enough of a secret to find it, never the whole thing. */
export const mask = (value: string): string => {
  if (value.startsWith('-----BEGIN')) {
    const header = value.match(/^-----BEGIN [A-Z ]{1,40}-----/)?.[0] ?? '-----BEGIN';
    return header.length === value.length ? header : `${header}… (${value.length} characters)`;
  }
  return `${value.slice(0, Math.min(4, Math.floor(value.length / 4)))}… (${value.length} characters)`;
};

/** Replace every secret in a piece of text with its masked form. */
export function maskSecrets(text: string): string {
  const found = findSecrets(text);
  if (found.length === 0) return text;
  let out = '';
  let at = 0;
  for (const s of found) {
    if (s.index < at) continue;
    out += text.slice(at, s.index) + mask(s.value);
    at = s.index + s.value.length;
  }
  return out + text.slice(at);
}
