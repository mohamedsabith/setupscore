import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Write a file so readers only ever see the old or the new content, never half of it: write a
 * temp file next to it, then rename it over the target. The rename also replaces a symbolic
 * link instead of writing through it. On failure (disk full, no permission) the original file
 * is left untouched and the error is re-thrown.
 */
export function writeFileAtomic(path: string, data: string | Buffer, mode = 0o644): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx', mode);
    const buf = typeof data === 'string' ? Buffer.from(data) : data;
    let at = 0;
    while (at < buf.length) at += writeSync(fd, buf, at, buf.length - at);
    try {
      fsyncSync(fd);
    } catch {
      // not supported on every file system
    }
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Create a folder only the current user can read (results can hold code and transcripts). */
export function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Read a text file that may be damaged or hostile: it must be a regular file (not a folder, a
 * FIFO or a device), and only the first and last parts of a huge file are read. Returns null
 * when it is missing or not a regular file.
 */
export function readTextSafely(path: string, maxBytes = 64 * 1024 * 1024): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  const fd = openSync(path, 'r');
  try {
    if (st.size <= maxBytes) {
      const buf = Buffer.alloc(st.size);
      let at = 0;
      while (at < st.size) {
        const n = readSync(fd, buf, at, st.size - at, at);
        if (n === 0) break;
        at += n;
      }
      return buf.subarray(0, at).toString('utf8');
    }
    // Keep the start and the end: transcripts end with the result line.
    const half = Math.floor(maxBytes / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    readSync(fd, head, 0, half, 0);
    readSync(fd, tail, 0, half, st.size - half);
    return `${head.toString('utf8')}\n${tail.toString('utf8')}`;
  } finally {
    closeSync(fd);
  }
}

/** Strip a UTF-8 byte order mark. */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** The last `maxBytes` of a regular file (whole when smaller); null when missing or not a regular file. */
export function readTailSafely(path: string, maxBytes: number): string | null {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return null;
  const fd = openSync(path, 'r');
  try {
    const size = Math.min(st.size, maxBytes);
    const buf = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = readSync(fd, buf, at, size - at, st.size - size + at);
      if (n === 0) break;
      at += n;
    }
    return buf.subarray(0, at).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/**
 * Call `onLine` for every line of a regular file, reading it in chunks, so files of any size
 * (beyond the largest string V8 can hold) can be read. Lines longer than `maxLine` bytes are
 * passed as null (too long to be what the caller expects). Returns false when the file is
 * missing or not a regular file.
 */
export function forEachLine(
  path: string,
  onLine: (line: string | null, n: number) => void,
  maxLine = 16 * 1024 * 1024,
): boolean {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return false;
  const fd = openSync(path, 'r');
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let parts: Buffer[] = [];
    let partBytes = 0;
    let tooLong = false;
    let n = 0;
    const emit = () => {
      n++;
      onLine(tooLong ? null : Buffer.concat(parts, partBytes).toString('utf8'), n);
      parts = [];
      partBytes = 0;
      tooLong = false;
    };
    const add = (b: Buffer) => {
      if (tooLong || !b.length) return;
      if (partBytes + b.length > maxLine) {
        tooLong = true;
        parts = [];
        partBytes = 0;
        return;
      }
      parts.push(Buffer.from(b)); // a copy: the chunk buffer is reused
      partBytes += b.length;
    };
    for (;;) {
      const got = readSync(fd, chunk, 0, chunk.length, null);
      if (got === 0) break;
      let from = 0;
      for (let nl = chunk.indexOf(10, from); nl !== -1 && nl < got; nl = chunk.indexOf(10, from)) {
        add(chunk.subarray(from, nl));
        emit();
        from = nl + 1;
      }
      if (from < got) add(chunk.subarray(from, got));
    }
    if (partBytes > 0 || tooLong) emit();
    return true;
  } finally {
    closeSync(fd);
  }
}
