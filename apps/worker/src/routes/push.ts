import type { Context } from 'hono'
import type { Env } from '../types'
import type { ChatSessionDO } from '../durable/ChatSessionDO'
import { log } from '../lib/logger'

type HonoEnv = { Bindings: Env }

/**
 * POST /push { chatId, content?, done? }
 * External service pushes a token directly into the DO (alternative to the
 * Worker pulling from a backend server).
 */
export async function pushRoute(c: Context<HonoEnv>): Promise<Response> {
  const requestId = crypto.randomUUID()

  let body: { chatId?: string; content?: string; done?: boolean }
  try {
    body = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  const { chatId, content, done } = body
  if (!chatId) return c.json({ error: 'chatId_required' }, 400)
  if (!done && !content?.trim()) return c.json({ error: 'content_or_done_required' }, 400)

  log({ event: 'push_request', requestId, chatId, done: !!done })

  const stub = c.env.CHAT_SESSION.get(c.env.CHAT_SESSION.idFromName(`chat:${chatId}`)) as DurableObjectStub<ChatSessionDO>

  if (done) {
    await stub.markDone()
    return c.json({ ok: true })
  }

  const seq = await stub.pushToken(content!)
  return c.json({ ok: true, seq })
}

/**
 * POST /start { chatId? }
 * Pre-initialise a session before any client connects (server-push workflow).
 */
export async function startRoute(c: Context<HonoEnv>): Promise<Response> {
  const requestId = crypto.randomUUID()

  let body: { chatId?: string } = {}
  try { body = await c.req.json() } catch { /* optional body */ }

  const chatId = body.chatId ?? crypto.randomUUID()
  log({ event: 'start_request', requestId, chatId })

  const stub = c.env.CHAT_SESSION.get(c.env.CHAT_SESSION.idFromName(`chat:${chatId}`)) as DurableObjectStub<ChatSessionDO>
  await stub.init(chatId)
  return c.json({ ok: true, chatId })
}
