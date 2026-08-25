#!/usr/bin/env python3
"""Feed a decrypted archive to a checker while draining after early EOF.

Some archive readers return as soon as their inventory is known. If the
reader's stdin is a pipe, that early close must not turn the decrypting
producer's successful completion into a SIGPIPE failure. The input remains a
FIFO, so plaintext is never stored on disk.
"""

from __future__ import annotations

import errno
import subprocess
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: stream_archive.py FIFO command...", file=sys.stderr)
        return 2

    fifo = sys.argv[1]
    command = sys.argv[2:]
    checker = subprocess.Popen(command, stdin=subprocess.PIPE)
    checker_stdin = checker.stdin
    assert checker_stdin is not None
    checker_closed = False

    with open(fifo, "rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            if checker_closed:
                continue
            try:
                checker_stdin.write(chunk)
                checker_stdin.flush()
            except BrokenPipeError:
                checker_closed = True
                checker_stdin.close()
            except OSError as error:
                if error.errno != errno.EPIPE:
                    raise
                checker_closed = True
                checker_stdin.close()

    if not checker_closed:
        checker_stdin.close()
    return checker.wait()


if __name__ == "__main__":
    raise SystemExit(main())
