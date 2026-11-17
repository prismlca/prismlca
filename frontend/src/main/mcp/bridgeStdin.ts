/**
 * The bridge's standard input: the stream the client's requests arrive on, and whose end means the
 * client is gone.
 *
 * On Windows that is not `process.stdin`. Electron replaces it there, in every process it starts, with
 * a stream that is empty and ends at once — a windowed program normally has no input, and Node used to
 * fail on the missing handle. A bridge reading it sees "the client closed stdin" the moment it starts
 * listening and exits, although the client's pipe is open and its `initialize` is waiting in it. So on
 * Windows the handle itself is opened: descriptor 0 is the pipe the client created, Electron or not.
 *
 * Electron-free, so the test can hand it a pipe of its own.
 */
import { createReadStream } from 'node:fs'
import { Socket } from 'node:net'
import type { Readable } from 'node:stream'

/** Reads descriptor `fd` whatever it is: a pipe as a socket, the way Node opens its own stdin, and a
 *  file or console as a file. A descriptor that cannot be read at all (no input handle: the bridge was
 *  started by hand from a windowed shell) reports it as the stream's `error`, followed by `close`. */
function openDescriptor(fd: number): Readable {
  try {
    return new Socket({ fd, readable: true, writable: false })
  } catch {
    // Not a pipe — Node refuses anything else here. The descriptor is the process's, never closed by us.
    return createReadStream('', { fd, autoClose: false })
  }
}

export function openBridgeStdin(platform: NodeJS.Platform = process.platform, fd = 0): Readable {
  return platform === 'win32' ? openDescriptor(fd) : process.stdin
}
