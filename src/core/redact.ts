/**
 * Remove credentials from anything setupscore saves or prints about a run: transcripts, error
 * reasons, test output. An agent that runs `env` would otherwise put the API key on disk.
 */
const SECRET_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
];

/** Key shapes that are secret wherever they appear. */
// A key may follow a word boundary, or a JSON escape such as \n (the text may be serialized JSON).
const START = '(?:(?<=\\\\[nrtbf])|(?<![A-Za-z0-9_]))';
const SECRET_SHAPES = new RegExp(
  [
    'sk-ant-[\\w-]{16,}', // Anthropic
    'sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}', // OpenAI and similar
    'gh[pousr]_[A-Za-z0-9]{30,}\\b', // GitHub
    'github_pat_[A-Za-z0-9_]{40,}\\b',
    'glpat-[A-Za-z0-9_-]{20,}', // GitLab
    'AKIA[0-9A-Z]{16}\\b', // AWS access key id
    'npm_[A-Za-z0-9]{30,}\\b', // npm
    'xox[abposr]-[A-Za-z0-9-]{10,}', // Slack
    'AIza[0-9A-Za-z_-]{35}\\b', // Google API key
    '[rs]k_live_[0-9A-Za-z]{20,}', // Stripe
  ]
    .map((shape) => START + shape)
    .concat('-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]{0,10000}?-----END [A-Z ]*PRIVATE KEY-----')
    .join('|'),
  'g',
);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

let cached: { key: string; re: RegExp | null } | null = null;

function valuesRegex(env: NodeJS.ProcessEnv): RegExp | null {
  const values = SECRET_VARS.map((k) => env[k]).filter((v): v is string => !!v && v.length >= 8);
  const key = values.join('\0');
  if (cached?.key === key) return cached.re;
  const re = values.length
    ? new RegExp(
        [...new Set(values)]
          .sort((a, b) => b.length - a.length)
          .map(escapeRe)
          .join('|'),
        'g',
      )
    : null;
  cached = { key, re };
  return re;
}

export function redact(text: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!text) return text;
  const re = valuesRegex(env);
  const out = re ? text.replace(re, '[redacted]') : text;
  return out.replace(SECRET_SHAPES, '[redacted]');
}
