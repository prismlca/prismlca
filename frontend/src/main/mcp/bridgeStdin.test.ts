/**
 * The bridge's own reading of standard input, on real descriptors: a pipe, a file, and one that is not
 * open. The Windows branch is forced by name, so it is exercised here wherever the suite runs; that the
 * descriptor really is the client's pipe on Windows is what the end-to-end test of the bridge shows.
 */
import { execFileSync } from 'node:child_process'
import { closeSync, constants, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { openBridgeStdin } from './bridgeStdin'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'prism-bridge-stdin-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Everything the stream delivers until it ends, and which of the events a shutdown listens for fired. */
function record(stream: Readable): { text: () => string; events: string[]; ended: Promise<void> } {
  const chunks: Buffer[] = []
  const events: string[] = []
  stream.on('data', (c: Buffer) => chunks.push(c))
  const ended = new Promise<void>((done) => {
    stream.once('end', () => {
      events.push('end')
      done()
    })
    stream.once('error', (e) => {
      events.push(`error ${(e as NodeJS.ErrnoException).code}`)
      done()
    })
  })
  stream.once('close', () => events.push('close'))
  return { text: () => Buffer.concat(chunks).toString('utf-8'), events, ended }
}

describe('openBridgeStdin', () => {
  it('is the process stream everywhere but on Windows', () => {
    expect(openBridgeStdin('linux')).toBe(process.stdin)
    expect(openBridgeStdin('darwin')).toBe(process.stdin)
  })

  // A named pipe stands in for the client's; Windows has no mkfifo, and there the end-to-end test
  // reads the real one.
  it.skipIf(process.platform === 'win32')(
    'reads the pipe behind the descriptor on Windows, and ends when the writer leaves',
    async () => {
      const fifo = join(dir, 'in')
      execFileSync('mkfifo', [fifo])
      const readFd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK)
      const writeFd = openSync(fifo, 'w')
      const stdin = openBridgeStdin('win32', readFd)
      expect(stdin).not.toBe(process.stdin)
      const seen = record(stdin)
      writeSync(writeFd, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
      await expect.poll(() => seen.text()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
      // The client is still there: nothing may look like its leaving.
      expect(seen.events).toEqual([])
      closeSync(writeFd)
      await seen.ended
      await expect.poll(() => seen.events).toEqual(['end', 'close'])
    }
  )

  it('reads a descriptor that is not a pipe as a file', async () => {
    const path = join(dir, 'requests.jsonl')
    writeFileSync(path, '{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
    const fd = openSync(path, 'r')
    try {
      const seen = record(openBridgeStdin('win32', fd))
      await seen.ended
      expect(seen.text()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n')
      expect(seen.events).toEqual(['end'])
    } finally {
      closeSync(fd)
    }
  })

  it('reports a descriptor that is not open as an error of the stream, never as a throw', async () => {
    // No process of ours has a million descriptors open.
    const seen = record(openBridgeStdin('win32', 1_000_000))
    await seen.ended
    expect(seen.events).toEqual(['error EBADF'])
  })
})
