import { formatSSE } from './sse'
import { log } from './logger'
import type { ChatSessionDO } from '../durable/ChatSessionDO'

// 200ms polling = ~560 polls for a 112s stream (vs 2240 at 50ms)
// keeps total subrequests well under Cloudflare's 1000/invocation limit
const POLL_INTERVAL_MS = 200
const PING_INTERVAL_MS = 15_000
const PUSH_BATCH_SIZE = 10   // 1125 tokens ÷ 10 = 113 pushTokenBatch calls

/**
 * Worker-side SSE delivery loop.
 *
 * Polls the DO for new chunks and writes them to the client's TransformStream
 * writer. The Worker keeps this running via ctx.waitUntil — the DO stays
 * stateless (pure storage).
 *
 * Resume flow:
 *   1. Drain current buffer (replay phase) → send replay_complete
 *   2. Poll for live chunks → send done when complete
 *
 * Fresh stream flow:
 *   1. Send start event
 *   2. Poll for live chunks → send done when complete
 */
export async function streamFromDO(
  stub: DurableObjectStub<ChatSessionDO>,
  chatId: string,
  lastSeq: number,
  writer: WritableStreamDefaultWriter<Uint8Array>,
  isResume: boolean,
): Promise<void> {
  let cursor = lastSeq
  let lastPingTs = Date.now()

  try {
    if (!isResume) {
      await writer.write(formatSSE('start', { chatId }))
    }

    // Replay phase: drain all chunks that exist right now before going live
    if (isResume) {
      let streamAlreadyDone = false
      while (true) {
        const { chunks, done } = await stub.poll(cursor)
        for (const chunk of chunks) {
          await writer.write(formatSSE('token', { seq: chunk.seq, content: chunk.content }))
          cursor = chunk.seq
        }
        if (chunks.length === 0) {
          streamAlreadyDone = done
          break
        }
      }
      await writer.write(formatSSE('replay_complete', {}))
      if (streamAlreadyDone) {
        await writer.write(formatSSE('done', {}))
        await writer.close()
        log({ event: 'resume_delivered_complete', chatId, finalSeq: cursor })
        return
      }
      lastPingTs = Date.now()
    }

    // Live phase: poll until stream is done
    while (true) {
      const { chunks, done } = await stub.poll(cursor)

      for (const chunk of chunks) {
        await writer.write(formatSSE('token', { seq: chunk.seq, content: chunk.content }))
        cursor = chunk.seq
        lastPingTs = Date.now()
      }

      if (done && chunks.length === 0) {
        await writer.write(formatSSE('done', {}))
        await writer.close()
        log({ event: 'stream_delivered', chatId, finalSeq: cursor })
        return
      }

      if (chunks.length === 0) {
        if (Date.now() - lastPingTs >= PING_INTERVAL_MS) {
          await writer.write(formatSSE('ping', {}))
          lastPingTs = Date.now()
        }
        await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS))
      }
    }
  } catch {
    try { await writer.close() } catch { /* ignore */ }
  }
}

/**
 * Calls the backend /generate endpoint, reads its SSE token stream, and
 * pushes each token into the DO via RPC. The Worker owns this pipeline —
 * the backend server is unaware of the DO or client.
 *
 * Backend SSE format expected:
 *   event: token\ndata: {"content":"<word>"}\n\n
 *   event: done\ndata: {}\n\n
 */
export async function pipeBackendToDO(
  backendUrl: string,
  chatId: string,
  message: string,
  stub: DurableObjectStub<ChatSessionDO>,
): Promise<void> {
  const res = await fetch(`${backendUrl}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  })

  if (!res.ok || !res.body) {
    throw new Error(`Backend responded ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let pending: string[] = []

  const flushBatch = async () => {
    if (pending.length === 0) return
    await stub.pushTokenBatch(pending)
    pending = []
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''

      for (const block of parts) {
        if (!block.trim()) continue
        let event = 'message'
        let data = ''
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7).trim()
          else if (line.startsWith('data: ')) data = line.slice(6).trim()
        }
        if (event === 'token') {
          const { content } = JSON.parse(data) as { content: string }
          pending.push(content)
          if (pending.length >= PUSH_BATCH_SIZE) await flushBatch()
        } else if (event === 'done') {
          await flushBatch()
          await stub.markDone()
          log({ event: 'backend_pipe_done', chatId })
          return
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  await flushBatch()
  await stub.markDone()
}
