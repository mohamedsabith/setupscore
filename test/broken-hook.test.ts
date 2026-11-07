import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/core/check.js';
import { git, initGit, issuesOf, makeRepo } from './helpers.js';

// broken-hook follows the hooks reference, code.claude.com/docs/en/hooks (Claude Code 2.1.319).

const RULE = 'broken-hook';
const posixOnly = process.platform === 'win32' ? it.skip : it;
const cmd = (command: string, extra: Record<string, unknown> = {}) => ({ type: 'command', command, ...extra });
const group = (handlers: unknown[], matcher?: unknown) =>
  matcher === undefined ? { hooks: handlers } : { matcher, hooks: handlers };
const settings = (hooks: unknown, files: Record<string, string> = {}, name = '.claude/settings.json') =>
  makeRepo({ [name]: JSON.stringify({ hooks }, null, 2), ...files });
const found = (hooks: unknown, files: Record<string, string> = {}) => issuesOf(settings(hooks, files), RULE);
const messages = (hooks: unknown, files: Record<string, string> = {}) => found(hooks, files).map((i) => i.message);
const ok = (hooks: unknown, files: Record<string, string> = {}) => expect(found(hooks, files)).toEqual([]);

describe('broken-hook: the shape of "hooks"', () => {
  it.each([
    ['a list', [cmd('echo hi')]],
    ['a string', 'echo hi'],
    ['a number', 1],
  ])('flags "hooks" that is %s', (_name, hooks) => {
    expect(messages(hooks)).toEqual([expect.stringContaining('"hooks" must be an object of events')]);
  });

  it('flags an event whose value is not a list', () => {
    expect(messages({ PreToolUse: group([cmd('echo hi')], 'Bash') })).toEqual([
      expect.stringContaining('PreToolUse must be a list of matcher groups'),
    ]);
  });

  it('flags a matcher group that is not an object', () => {
    expect(messages({ Stop: ['echo hi'] })).toEqual([
      expect.stringContaining('Stop has an entry that is not an object'),
    ]);
  });

  it('flags a handler written straight into the list, the most common mistake, with the wrapper as the hint', () => {
    const [i, ...rest] = found({ PostToolUse: [cmd('npx prettier --write .')] });
    expect(rest).toEqual([]);
    expect(i!.message).toContain('without the "hooks" wrapper');
    expect(i!.hint).toContain('{ "matcher": "...", "hooks": [');
  });

  it('flags a matcher group with no "hooks" list', () => {
    expect(messages({ PreToolUse: [{ matcher: 'Bash' }] })).toEqual([expect.stringContaining('has no "hooks" list')]);
  });

  it('flags a handler that is not an object', () => {
    expect(messages({ Stop: [group(['echo hi'])] })).toEqual([expect.stringContaining('Stop hook is not an object')]);
  });

  it('points at the line of the event or the command', () => {
    const root = settings({ PostToolUse: [cmd('npx prettier --write .')] });
    const [i] = issuesOf(root, RULE);
    // { / "hooks": { / "PostToolUse": [ / { / "type": ... / "command": ... -> line 6
    expect(i!.line).toBe(6);
  });
});

describe('broken-hook: event names', () => {
  it.each([
    ['pretooluse', 'PreToolUse'],
    ['preToolUse', 'PreToolUse'],
    ['PRETOOLUSE', 'PreToolUse'],
    ['posttooluse', 'PostToolUse'],
    ['sessionstart', 'SessionStart'],
    ['stop', 'Stop'],
  ])('flags "%s" as the wrong letter case of %s', (event, right) => {
    const [i] = found({ [event]: [group([cmd('echo hi')])] });
    expect(i!.message).toContain('Event names are case-sensitive');
    expect(i!.hint).toBe(`Did you mean "${right}"?`);
  });

  it.each([
    ['PreToolUs', 'PreToolUse'],
    ['PostToolUsee', 'PostToolUse'],
    ['UserPromptSubmitt', 'UserPromptSubmit'],
    ['SesionStart', 'SessionStart'],
  ])('flags the typo "%s" and suggests %s', (event, right) => {
    expect(found({ [event]: [group([cmd('echo hi')])] })[0]!.hint).toBe(`Did you mean "${right}"?`);
  });

  it('leaves a name far from every known event alone: it may be newer than our list', () => {
    ok({ MyBrandNewEvent: [group([cmd('echo hi')])] });
  });

  it.each([
    'SessionStart',
    'Setup',
    'InstructionsLoaded',
    'UserPromptSubmit',
    'UserPromptExpansion',
    'MessageDisplay',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'PostToolBatch',
    'PermissionDenied',
    'Notification',
    'SubagentStart',
    'SubagentStop',
    'TaskCreated',
    'TaskCompleted',
    'Stop',
    'StopFailure',
    'TeammateIdle',
    'ConfigChange',
    'CwdChanged',
    'DirectoryAdded',
    'FileChanged',
    'WorktreeCreate',
    'WorktreeRemove',
    'PreCompact',
    'PostCompact',
    'PreModelSwitch',
    'PostModelSwitch',
    'SessionEnd',
    'Elicitation',
    'ElicitationResult',
  ])('accepts the documented event %s', (event) => {
    ok({ [event]: [group([cmd('echo hi')])] });
  });
});

describe('broken-hook: matchers', () => {
  it.each([
    ['a list', ['Edit', 'Write']],
    ['an object', { tool: 'Bash' }],
    ['a number', 1],
    ['true', true],
  ])('flags a matcher that is %s, and says it can stop every hook in the file', (_name, matcher) => {
    const [i] = found({ PreToolUse: [group([cmd('echo hi')], matcher)] });
    expect(i!.message).toContain('must be one string');
    expect(i!.message).toContain('so this hook never runs');
    expect(i!.message).toContain('stop every other hook in this file from loading');
    expect(i!.hint).toContain('"Edit|Write"');
  });

  it.each([
    '',
    '*',
    'Bash',
    'Edit|Write',
    'Edit, Write',
    'Edit | Write',
    '^Notebook',
    '.*',
    'mcp__memory__.*',
    'mcp__.*__write.*',
    'Bash(git *)',
    '^Edit$',
    'Write|Edit|MultiEditX',
  ])('accepts the PreToolUse matcher %j', (matcher) => ok({ PreToolUse: [group([cmd('echo hi')], matcher)] }));

  it('only mentions the effect on other hooks for PreToolUse and PermissionRequest', () => {
    const [i] = found({ PostToolUse: [group([cmd('echo hi')], ['Edit'])] });
    expect(i!.message).toContain('so this hook never runs');
    expect(i!.message).not.toContain('every other hook');
  });

  it('accepts an omitted matcher and a null one', () => {
    ok({ PreToolUse: [group([cmd('echo hi')])] });
    ok({ PreToolUse: [group([cmd('echo hi')], null)] });
  });

  it.each(['(', '[a-', 'Edit|(Write', '*.ts', '+Bash'])(
    'flags the matcher %j: not a valid regular expression',
    (matcher) => {
      expect(messages({ PreToolUse: [group([cmd('echo hi')], matcher)] })).toEqual([
        expect.stringContaining('is not a valid regular expression'),
      ]);
    },
  );

  it.each([
    ['mcp__github', 'mcp__github__.*'],
    ['mcp__brave-search', 'mcp__brave-search__.*'],
    ['mcp__plugin_my-plugin_db', 'mcp__plugin_my-plugin_db__.*'],
  ])('flags the MCP matcher %s, which matches no tool', (matcher, right) => {
    const [i] = found({ PreToolUse: [group([cmd('echo hi')], matcher)] });
    expect(i!.message).toContain('matches no tool: MCP tools are named mcp__<server>__<tool>');
    expect(i!.hint).toContain(`"${right}"`);
  });

  it('flags the bare MCP item inside a list, and accepts full MCP tool names', () => {
    expect(found({ PreToolUse: [group([cmd('echo hi')], 'Bash|mcp__memory')] })).toHaveLength(1);
    ok({ PreToolUse: [group([cmd('echo hi')], 'mcp__memory__create_entities|mcp__github__search_repositories')] });
  });

  it.each([
    ['bash', 'Bash'],
    ['write', 'Write'],
    ['NOTEBOOKEDIT', 'NotebookEdit'],
    ['webfetch', 'WebFetch'],
  ])('flags the tool name %s in the wrong case', (matcher, right) => {
    const [i] = found({ PostToolUse: [group([cmd('echo hi')], matcher)] });
    expect(i!.message).toContain('tool names are case-sensitive');
    expect(i!.hint).toBe(`Write "${right}".`);
  });

  it('flags each wrongly cased tool in a list', () => {
    expect(found({ PostToolUse: [group([cmd('echo hi')], 'write|edit')] })).toHaveLength(2);
  });

  it('leaves unknown tool names alone: they may be custom or new tools', () => {
    ok({ PreToolUse: [group([cmd('echo hi')], 'my_custom_tool|SomeNewTool')] });
  });

  it('only checks tool names on tool events', () => {
    ok({ SessionStart: [group([cmd('echo hi')], 'startup')] });
    ok({ SubagentStart: [group([cmd('echo hi')], 'mcp__x')] });
    ok({ Notification: [group([cmd('echo hi')], 'bash')] });
  });

  it.each(['UserPromptSubmit', 'Stop', 'CwdChanged', 'PostToolBatch', 'MessageDisplay'])(
    'flags a matcher on %s, which has no matcher support, so the hook runs every time',
    (event) => {
      expect(messages({ [event]: [group([cmd('echo hi')], 'Bash')] })).toEqual([
        expect.stringContaining('is ignored and this hook runs every time'),
      ]);
      ok({ [event]: [group([cmd('echo hi')], '*')] });
      ok({ [event]: [group([cmd('echo hi')], '')] });
    },
  );

  it('reads FileChanged and StopFailure matchers with their own rules', () => {
    ok({ FileChanged: [group([cmd('echo hi')], '.envrc|.env')] });
    ok({ StopFailure: [group([cmd('echo hi')], 'rate_limit|overloaded')] });
  });
});

describe('broken-hook: handlers', () => {
  it('flags a handler with no "type"', () => {
    const [i] = found({ Stop: [group([{ command: 'echo done' }])] });
    expect(i!.message).toContain('has no "type"');
    expect(i!.hint).toContain('"type": "command"');
  });

  it.each([
    ['Command', 'command'],
    ['HTTP', 'http'],
    ['mcp-tool', 'mcp_tool'],
    ['commands', 'command'],
  ])('flags the type %j and suggests %j', (type, right) => {
    expect(found({ Stop: [group([{ type, command: 'echo done' }])] })[0]!.hint).toBe(`Did you mean "${right}"?`);
  });

  it('leaves a type far from every known one alone: it may be newer', () => {
    ok({ Stop: [group([{ type: 'webassembly', module: 'x.wasm' }])] });
  });

  it.each([
    [{ type: 'command' }, 'command'],
    [{ type: 'command', command: '' }, 'command'],
    [{ type: 'command', command: '   ' }, 'command'],
    [{ type: 'command', command: 42 }, 'command'],
    [{ type: 'http' }, 'url'],
    [{ type: 'prompt' }, 'prompt'],
    [{ type: 'agent' }, 'prompt'],
  ])('flags %j: no "%s"', (handler, field) => {
    expect(messages({ Stop: [group([handler])] })).toEqual([expect.stringContaining(`has no "${field}"`)]);
  });

  it('flags an mcp_tool hook without server and tool, once for each', () => {
    expect(messages({ PostToolUse: [group([{ type: 'mcp_tool' }], 'Write')] })).toHaveLength(2);
  });

  it.each([
    cmd('echo hi'),
    {
      type: 'http',
      url: 'http://localhost:8080/hook',
      headers: { Authorization: 'Bearer $TOKEN' },
      allowedEnvVars: ['TOKEN'],
    },
    { type: 'mcp_tool', server: 'my_server', tool: 'security_scan', input: { file_path: '${tool_input.file_path}' } },
    { type: 'prompt', prompt: 'Is this safe? $ARGUMENTS' },
    { type: 'agent', prompt: 'Check the tests pass.' },
  ])('accepts a complete %j hook', (handler) => ok({ Stop: [group([handler])] }));

  it.each(['30s', '30', 0, -5, true, null])('flags "timeout": %j', (timeout) => {
    expect(messages({ Stop: [group([cmd('echo hi', { timeout })])] })).toEqual([
      expect.stringContaining('It must be a number of seconds above 0'),
    ]);
  });

  it('shows the timeout value once quoted, as written in the file', () => {
    expect(found({ Stop: [group([cmd('echo hi', { timeout: '30s' })])] })[0]!.message).toContain(
      'has "timeout": "30s". It must',
    );
    expect(found({ Stop: [group([cmd('echo hi', { timeout: 0 })])] })[0]!.message).toContain(
      'has "timeout": 0. It must',
    );
  });

  it.each([30, 0.5, 600])('accepts "timeout": %j', (timeout) => ok({ Stop: [group([cmd('echo hi', { timeout })])] }));

  it('flags "if" on an event that is not a tool event: that hook never runs', () => {
    const [i] = found({ Stop: [group([cmd('echo hi', { if: 'Bash(git *)' })])] });
    expect(i!.message).toContain('so this hook never runs');
  });

  it('accepts "if" on tool events, and an empty "if" anywhere', () => {
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied']) {
      ok({ [event]: [group([cmd('echo hi', { if: 'Bash(git *)' })], 'Bash')] });
    }
    ok({ Stop: [group([cmd('echo hi', { if: '' })])] });
  });

  it('accepts current optional fields: async, asyncRewake, shell, onFailure, statusMessage, once, args', () => {
    ok({
      PreToolUse: [
        group(
          [
            cmd('node', {
              args: ['-e', '1'],
              async: true,
              asyncRewake: false,
              shell: 'bash',
              onFailure: 'block',
              statusMessage: 'Checking',
              once: true,
            }),
          ],
          'Bash',
        ),
      ],
    });
  });

  it('never prints a secret from a hook command in full', () => {
    const secret = 'sk-ant-api03-REALLOOKINGKEY0123456789abcdefghijkl';
    const [i] = found({ Stop: [group([{ command: `curl -H "x-api-key: ${secret}" https://example.com` }])] });
    expect(i!.message).not.toContain(secret);
  });
});

describe('broken-hook: scripts under ${CLAUDE_PROJECT_DIR}', () => {
  it.each([
    '"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
    '"${CLAUDE_PROJECT_DIR}"/.claude/hooks/check.sh',
    '"$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh"',
    '${CLAUDE_PROJECT_DIR}/.claude/hooks/check.sh',
    '$CLAUDE_PROJECT_DIR/.claude/hooks/check.sh --strict',
    'FORCE=1 "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
    'cd src && "$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh',
  ])('flags a missing script run as %s', (command) => {
    expect(messages({ PostToolUse: [group([cmd(command)], 'Edit')] })).toEqual([
      "The PostToolUse hook runs .claude/hooks/check.sh, but the file doesn't exist, so the hook never runs.",
    ]);
  });

  it.each([
    ['python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/guard.py"', 'python3'],
    ['python "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.py', 'python'],
    ['sh "$CLAUDE_PROJECT_DIR"/.claude/hooks/guard.py', 'sh'],
  ])('warns that %s blocks every action when the script is missing (exit code 2)', (command, interpreter) => {
    const [i] = found({ PreToolUse: [group([cmd(command)], 'Bash')] });
    expect(i!.message).toContain(
      `with ${interpreter}, but the file doesn't exist. ${interpreter} then exits with code 2`,
    );
  });

  it.each([
    'node "$CLAUDE_PROJECT_DIR"/hooks/a.js',
    'bash "$CLAUDE_PROJECT_DIR"/hooks/a.sh',
    'bun "$CLAUDE_PROJECT_DIR"/hooks/a.ts',
  ])('flags a missing script run by %s', (command) => {
    expect(messages({ Stop: [group([cmd(command)])] })).toEqual([
      expect.stringContaining("but the file doesn't exist"),
    ]);
  });

  it('checks exec form: the command itself, or the script an interpreter runs', () => {
    expect(found({ Stop: [group([cmd('${CLAUDE_PROJECT_DIR}/hooks/a.sh', { args: [] })])] })).toHaveLength(1);
    expect(
      found({ Stop: [group([cmd('node', { args: ['${CLAUDE_PROJECT_DIR}/hooks/a.js', '--fix'] })])] }),
    ).toHaveLength(1);
  });

  it.each([
    'tee "$CLAUDE_PROJECT_DIR/hook.log"',
    'echo done >> "$CLAUDE_PROJECT_DIR/hook.log"',
    'cat "$CLAUDE_PROJECT_DIR/notes.txt" | wc -l',
    'cd "$CLAUDE_PROJECT_DIR" && npm test',
    '"$CLAUDE_PROJECT_DIR"/hooks/$NAME.sh',
    '"$CLAUDE_PROJECT_DIR"/hooks/*.sh',
    '~/.claude/hooks/check.sh',
    '/usr/local/bin/check',
    '${CLAUDE_PLUGIN_ROOT}/scripts/format.sh',
    './scripts/check.sh',
    '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/eslint .',
    '"$CLAUDE_PROJECT_DIR"/../shared/check.sh',
    'python3 -u "$CLAUDE_PROJECT_DIR"/hooks/a.py',
  ])('does not guess about %s', (command) => ok({ Stop: [group([cmd(command)])] }));

  it('finds every missing script whatever the order of exec-form and shell-form hooks (regression)', () => {
    const execForm = cmd('${CLAUDE_PROJECT_DIR}/hooks/exec.sh', { args: [] });
    const shellForm = cmd('"$CLAUDE_PROJECT_DIR"/hooks/shell.sh');
    for (const handlers of [
      [execForm, shellForm],
      [shellForm, execForm],
      [execForm, execForm, shellForm, shellForm],
    ]) {
      const paths = found({ Stop: [group(handlers)] }).map((i) => i.message.match(/runs (\S+),/)?.[1]);
      expect(new Set(paths)).toEqual(new Set(['hooks/exec.sh', 'hooks/shell.sh']));
    }
    // And across separate checks: one check must not change the next.
    expect(found({ Stop: [group([execForm])] })).toHaveLength(1);
    expect(
      found({ Stop: [group([cmd('x "$CLAUDE_PROJECT_DIR"/a.sh; "$CLAUDE_PROJECT_DIR"/hooks/later.sh')])] }),
    ).toHaveLength(1);
  });

  it('does not flag tee in exec form: its argument is an output file', () => {
    ok({ Stop: [group([cmd('tee', { args: ['${CLAUDE_PROJECT_DIR}/hook.log'] })])] });
  });

  it('accepts a script that exists, and a folder', () => {
    const files = { '.claude/hooks/check.sh': '#!/bin/sh\n', 'hooks/a.py': 'print(1)\n' };
    ok(
      { Stop: [group([cmd('python3 "$CLAUDE_PROJECT_DIR"/hooks/a.py'), cmd('ls "$CLAUDE_PROJECT_DIR"/hooks')])] },
      files,
    );
  });

  it('reports a missing script once, even when two hooks run it', () => {
    expect(
      found({
        PreToolUse: [
          group([cmd('"$CLAUDE_PROJECT_DIR"/x.sh')], 'Bash'),
          group([cmd('"$CLAUDE_PROJECT_DIR"/x.sh')], 'Edit'),
        ],
      }),
    ).toHaveLength(1);
  });

  it('does not flag a missing script that .gitignore ignores: it may be generated on each machine', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/.claude/hooks/generated.sh')])] },
      { '.gitignore': '.claude/hooks/generated.sh\n' },
    );
    initGit(root);
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  it('resolves ${CLAUDE_PROJECT_DIR} from a settings file in a subfolder', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/hooks/a.sh')])] },
      { 'pkg/hooks/a.sh': '#!/bin/sh\n' },
      'pkg/.claude/settings.json',
    );
    chmodSync(join(root, 'pkg/hooks/a.sh'), 0o755);
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  it('checks settings.local.json too', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/missing.sh')])] },
      {},
      '.claude/settings.local.json',
    );
    expect(issuesOf(root, RULE).map((i) => i.file)).toEqual(['.claude/settings.local.json']);
  });
});

describe('broken-hook: the executable bit', () => {
  posixOnly('flags a script git stores as not executable (100644), with the git command to fix it', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh')])] },
      { '.claude/hooks/check.sh': '#!/bin/sh\n' },
    );
    initGit(root);
    const [i] = issuesOf(root, RULE);
    expect(i!.message).toContain('git stores it as not executable');
    expect(i!.hint).toBe('Run: git update-index --chmod=+x .claude/hooks/check.sh');
  });

  posixOnly('accepts a script git stores as executable (100755)', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/.claude/hooks/check.sh')])] },
      { '.claude/hooks/check.sh': '#!/bin/sh\n' },
    );
    initGit(root);
    git(root, 'update-index', '--chmod=+x', '.claude/hooks/check.sh');
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  posixOnly('flags an untracked script without the executable bit, with chmod as the fix', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/hooks/a.sh')])] },
      { 'hooks/a.sh': '#!/bin/sh\n' },
    );
    chmodSync(join(root, 'hooks/a.sh'), 0o644);
    expect(issuesOf(root, RULE)[0]!.hint).toBe('Run: chmod +x hooks/a.sh');
    chmodSync(join(root, 'hooks/a.sh'), 0o755);
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  posixOnly('does not need the executable bit when an interpreter runs the script', () => {
    const root = settings(
      {
        Stop: [
          group([
            cmd('python3 "$CLAUDE_PROJECT_DIR"/hooks/a.py'),
            cmd('node', { args: ['${CLAUDE_PROJECT_DIR}/hooks/b.js'] }),
          ]),
        ],
      },
      {
        'hooks/a.py': 'print(1)\n',
        'hooks/b.js': '1\n',
      },
    );
    chmodSync(join(root, 'hooks/a.py'), 0o644);
    chmodSync(join(root, 'hooks/b.js'), 0o644);
    initGit(root);
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  posixOnly('ignores the bit for Windows scripts (.ps1, .cmd)', () => {
    const root = settings(
      { Stop: [group([cmd('"$CLAUDE_PROJECT_DIR"/hooks/a.ps1')])] },
      { 'hooks/a.ps1': 'Write-Host 1\n' },
    );
    chmodSync(join(root, 'hooks/a.ps1'), 0o644);
    expect(issuesOf(root, RULE)).toEqual([]);
  });
});

describe('broken-hook: effect on the rest of check', () => {
  it('reports nothing for a settings file without hooks, or with no hooks yet', () => {
    expect(issuesOf(makeRepo({ '.claude/settings.json': '{"permissions":{"allow":[]}}' }), RULE)).toEqual([]);
    ok({});
  });

  it('leaves a settings file with a JSON error to invalid-config', () => {
    const root = makeRepo({ '.claude/settings.json': '{"hooks": {"Stop": [}' });
    expect(issuesOf(root, RULE)).toEqual([]);
    expect(issuesOf(root, 'invalid-config')).toHaveLength(1);
  });

  it('reports nothing for a realistic, correct setup', () => {
    const root = settings(
      {
        PreToolUse: [
          group([cmd('"$CLAUDE_PROJECT_DIR"/.claude/hooks/block-rm.sh', { timeout: 10, onFailure: 'block' })], 'Bash'),
        ],
        PostToolUse: [group([cmd('npx prettier --write "$(jq -r .tool_input.file_path)"')], 'Edit|Write|MultiEdit')],
        SessionStart: [group([cmd('git status --short')], 'startup|resume')],
        Stop: [group([{ type: 'prompt', prompt: 'Did Claude run the tests? $ARGUMENTS' }])],
        Notification: [group([cmd('notify-send "Claude needs you"')], 'permission_prompt')],
      },
      { '.claude/hooks/block-rm.sh': '#!/bin/sh\nexit 0\n' },
    );
    chmodSync(join(root, '.claude/hooks/block-rm.sh'), 0o755);
    expect(issuesOf(root, RULE)).toEqual([]);
  });

  it('is a warning that costs 0.5 health, can be turned off, and can be raised to an error', () => {
    const hooks = { pretooluse: [group([cmd('echo hi')])] };
    const run = check(settings(hooks), { config: { rules: {}, ignore: [] } });
    expect(run.issues.map((i) => [i.rule, i.severity])).toEqual([[RULE, 'warning']]);
    expect(run.health).toBe(9.5);
    expect(issuesOf(settings(hooks), RULE, { config: { rules: { [RULE]: 'off' }, ignore: [] } })).toEqual([]);
    const strict = check(settings(hooks), { config: { rules: { [RULE]: 'error' }, ignore: [] } });
    expect(strict.issues.map((i) => i.severity)).toEqual(['error']);
  });

  it('runs alongside the other settings rules without changing them', () => {
    const root = makeRepo({
      '.claude/settings.json': JSON.stringify({
        permissions: { allow: ['Bash'] },
        hooks: { pretooluse: [group([cmd('echo hi')])] },
      }),
    });
    const rules = check(root, { config: { rules: {}, ignore: [] } })
      .issues.map((i) => i.rule)
      .sort();
    expect(rules).toEqual([RULE, 'risky-permission']);
  });
});

describe('broken-hook: never crashes, whatever the settings file holds', () => {
  // A small seeded random generator, so a failure can be reproduced.
  const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const KEYS = [
    'hooks',
    'matcher',
    'type',
    'command',
    'args',
    'timeout',
    'if',
    'url',
    'server',
    'tool',
    'prompt',
    'PreToolUse',
    'pretooluse',
    'Stop',
    'FileChanged',
    'UserPromptSubmit',
    '',
    '__proto__',
    'constructor',
  ];
  const STRINGS = [
    '',
    '*',
    'Bash',
    'bash',
    'mcp__x',
    '(',
    '[a-',
    'command',
    'Command',
    '"$CLAUDE_PROJECT_DIR"/x.sh',
    'python3 "$CLAUDE_PROJECT_DIR/a.py"',
    '${CLAUDE_PROJECT_DIR}',
    '$CLAUDE_PROJECT_DIR/../..',
    'é😀\u0000',
    'x'.repeat(5000),
    '$CLAUDE_PROJECT_DIR/a'.repeat(300),
  ];
  function value(r: () => number, depth: number): unknown {
    const k = Math.floor(r() * (depth > 3 ? 5 : 8));
    if (k === 0) return STRINGS[Math.floor(r() * STRINGS.length)];
    if (k === 1) return Math.floor(r() * 2000) - 1000;
    if (k === 2) return r() > 0.5;
    if (k === 3) return null;
    if (k === 4) return r() * 10;
    if (k === 5 || k === 6) {
      const o: Record<string, unknown> = {};
      for (let i = Math.floor(r() * 4); i > 0; i--) o[KEYS[Math.floor(r() * KEYS.length)]!] = value(r, depth + 1);
      return o;
    }
    return Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth + 1));
  }

  it('checks 300 random, malformed settings files without an error, and every message is short and readable', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = random(seed);
      const root = makeRepo({ '.claude/settings.json': JSON.stringify({ hooks: value(r, 0) }) });
      const run = check(root, { config: { rules: {}, ignore: [] } });
      expect(run.ruleErrors, `seed ${seed}`).toEqual([]);
      for (const i of run.issues.filter((i) => i.rule === RULE)) {
        expect(i.file).toBe('.claude/settings.json');
        expect(i.message.length, `seed ${seed}`).toBeLessThan(400);
        expect(i.message).not.toMatch(/undefined|\[object Object\]|NaN/);
      }
    }
  });

  it('skips the script check for a very long command, and stays fast', () => {
    const command = '"$CLAUDE_PROJECT_DIR"/missing.sh '.repeat(20_000);
    const t = Date.now();
    ok({ Stop: [group([cmd(command)])] });
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('stays fast for a settings file with thousands of hooks', () => {
    const groups = Array.from({ length: 3000 }, (_, n) => group([cmd(`"$CLAUDE_PROJECT_DIR"/hooks/h${n}.sh`)], 'Bash'));
    const t = Date.now();
    expect(found({ PreToolUse: groups })).toHaveLength(3000);
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('uses plain words: no "undefined", "[object Object]" or code names in any message', () => {
    const all = [
      ...messages({ PreToolUse: [group([{ type: { a: 1 }, command: 'x' }], { a: 1 })] }),
      ...messages({ Stop: [group([{ type: 'command', timeout: { s: 30 } }])] }),
      ...messages({ Stop: [group([{}])] }),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) expect(m).not.toMatch(/undefined|\[object Object\]|NaN/);
  });
});
