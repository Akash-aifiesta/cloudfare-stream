import type { Context } from 'hono'
import type { Env } from '../types'
import type { ChatSessionDO } from '../durable/ChatSessionDO'
import { log } from '../lib/logger'
import { streamFromDO } from '../lib/do-stream'

type HonoEnv = { Bindings: Env }

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
}

export async function resumeRoute(c: Context<HonoEnv>): Promise<Response> {
  const requestId = crypto.randomUUID()

  let body: { chatId?: string; lastSequence?: number }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const { chatId, lastSequence } = body
  if (!chatId) return c.json({ error: 'chatId_required' }, 400)
  if (lastSequence === undefined || lastSequence === null) {
    return c.json({ error: 'lastSequence_required' }, 400)
  }

  log({ event: 'resume_request', requestId, chatId, lastSequence })

  const stub = c.env.CHAT_SESSION.get(c.env.CHAT_SESSION.idFromName(`chat:${chatId}`)) as DurableObjectStub<ChatSessionDO>
  const { valid, expired } = await stub.isValid()
  if (!valid) {
    return new Response(
      JSON.stringify({ error: expired ? 'stream_expired' : 'not_found' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  c.executionCtx.waitUntil(
    streamFromDO(stub, chatId, lastSequence, writer, true).catch(
      (err) => log({ event: 'resume_stream_error', chatId, error: String(err) })
    )
  )

  return new Response(readable, { headers: SSE_HEADERS })
}
