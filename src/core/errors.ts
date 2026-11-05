/**
 * Errors with a plain-English message and how to fix it. The CLI prints these without a
 * stack trace and exits with the matching code. Anything else is a bug in setupscore.
 */

/** Wrong command, flag or input file: exit code 2. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly fixes: string[] = [],
  ) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The run stopped before the end (budget reached or Ctrl+C); partial results are saved: exit code 4. */
export class StoppedEarly extends Error {
  constructor(
    message: string,
    readonly fixes: string[] = [],
  ) {
    super(message);
    this.name = 'StoppedEarly';
  }
}

/** Nothing to measure (for example no usable tasks): exit code 1, like "problems found". */
export class NothingToDo extends Error {
  constructor(
    message: string,
    readonly fixes: string[] = [],
  ) {
    super(message);
    this.name = 'NothingToDo';
  }
}
