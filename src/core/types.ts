export type Severity = 'error' | 'warning';
export type RuleSetting = Severity | 'off';

/** Replace `from` with `to` on one line of one file. */
export interface Fix {
  file: string;
  line: number;
  /** 1-based column where `from` starts. Without it, the first occurrence on the line is replaced. */
  column?: number;
  from: string;
  to: string;
}

export interface Issue {
  rule: string;
  severity: Severity;
  /** Path relative to the checked folder, always with forward slashes. */
  file: string;
  line?: number;
  column?: number;
  message: string;
  /** A short "how to fix it" note. */
  hint?: string;
  /** Present when `--fix` can repair this safely. */
  fix?: Fix;
}

export type FileKind =
  | 'claude-md'
  | 'claude-local-md'
  | 'import'
  | 'rule'
  | 'skill'
  | 'agent'
  | 'command'
  | 'settings'
  | 'settings-local'
  | 'mcp';

export interface Line {
  /** 1-based line number. */
  n: number;
  text: string;
  /** True inside a fenced code block (``` or ~~~), fence lines included. */
  inFence: boolean;
  /** True inside the YAML frontmatter, delimiters included. */
  inFrontmatter: boolean;
}

export interface Frontmatter {
  data: Record<string, unknown> | null;
  error?: string;
  /** 1-based line number of the closing `---`. */
  endLine: number;
}

export interface SetupFile {
  /** Relative to the checked folder, forward slashes. */
  path: string;
  /** Where the file really is when it is reached through a symbolic link inside the project. */
  realPath?: string;
  abs: string;
  kind: FileKind;
  text: string;
  lines: Line[];
  frontmatter?: Frontmatter;
  /** True when Claude Code loads this file into every session at start-up. */
  loadsAtStart: boolean;
  /** For `import` files: the file that imported it and the hop count. */
  importedBy?: string;
  importDepth?: number;
}

/** One `@path` import written in an instruction file. */
export interface ImportRef {
  /** File that contains the import. */
  from: string;
  line: number;
  column: number;
  /** Exactly as written, without the `@`. */
  raw: string;
  /** Resolved path relative to the root (may start with `../` when outside it). */
  target: string;
  exists: boolean;
  /** 1 for an import written in a CLAUDE.md, 2 for an import inside that file, and so on. */
  depth: number;
}

/** A setup file that was found but could not be checked. */
export interface SkippedFile {
  path: string;
  kind: FileKind;
  /** too-big: over the size limit; unreadable: no permission or an I/O error; not-utf8: saved as UTF-16. */
  problem: 'too-big' | 'unreadable' | 'not-utf8';
  /** Size in bytes for too-big, the reason for the others. */
  detail: string;
}

/** A file named like a setup file in the wrong letter case (claude.md, .Claude/, skill.md). */
export interface MisnamedFile {
  /** The path as it is on disk (a folder path when a folder name is wrong). */
  path: string;
  /** The path Claude Code looks for. */
  expected: string;
  /** case: only the letter case is wrong; layout: the file is in a place Claude Code does not look. */
  reason?: 'case' | 'layout';
}

export interface Context {
  root: string;
  files: SetupFile[];
  imports: ImportRef[];
  /** Setup files that could not be read (too big, no permission, wrong encoding). */
  skipped?: SkippedFile[];
  /** Folders inside the project that could not be listed (no permission). */
  unreadableDirs?: string[];
  /** Files whose names only differ in letter case from what Claude Code looks for. */
  misnamed?: MisnamedFile[];
  /** Every file in the folder (relative, forward slashes), skipping node_modules, .git, build output. */
  repoFiles(): string[];
  existsRel(rel: string): boolean;
  isDir(rel: string): boolean;
  /** Old path -> current path, from `git log` renames. Empty when git is unavailable. */
  renames(): Map<string, string>;
}

export interface Rule {
  id: string;
  severity: Severity;
  /** One line: what the rule checks. */
  summary: string;
  /** Why it matters, in plain words. */
  why: string;
  check(ctx: Context): Issue[];
}

export interface FileReport {
  path: string;
  kind: FileKind;
  loadsAtStart: boolean;
  tokens: number;
}

export interface CheckResult {
  root: string;
  files: FileReport[];
  issues: Issue[];
  errors: number;
  warnings: number;
  fixable: number;
  /** 0 to 10. 10 minus 1 per error and 0.5 per warning. */
  health: number;
  /** Rough token cost of what loads into every session. */
  startupTokens: number;
}
