import type { Context } from 'hono'
import type { Env } from '../types'
import type { ChatSessionDO } from '../durable/ChatSessionDO'
import { log } from '../lib/logger'
import { pipeBackendToDO, streamFromDO } from '../lib/do-stream'

type HonoEnv = { Bindings: Env }

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
}

export async function streamRoute(c: Context<HonoEnv>): Promise<Response> {
  const requestId = crypto.randomUUID()

  let body: { chatId?: string; message?: string }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const message = body.message?.trim()
  if (!message) return c.json({ error: 'message_required' }, 400)
  if (!c.env.BACKEND_URL) return c.json({ error: 'BACKEND_URL not configured' }, 503)

  const chatId = body.chatId ?? crypto.randomUUID()
  log({ event: 'stream_request', requestId, chatId })

  const stub = c.env.CHAT_SESSION.get(c.env.CHAT_SESSION.idFromName(`chat:${chatId}`)) as DurableObjectStub<ChatSessionDO>
  await stub.init(chatId)

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()

  // Background: pull backend SSE → push tokens into DO storage
  c.executionCtx.waitUntil(
    pipeBackendToDO(c.env.BACKEND_URL, chatId, message, stub).catch(
      (err) => log({ event: 'backend_pipe_error', chatId, error: String(err) })
    )
  )

  // Background: poll DO storage → write SSE to client (keeps Worker alive)
  c.executionCtx.waitUntil(
    streamFromDO(stub, chatId, 0, writer, false).catch(
      (err) => log({ event: 'stream_error', chatId, error: String(err) })
    )
  )

  return new Response(readable, { headers: SSE_HEADERS })
}
