import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { generateTokens } from './token-generator.js'

const app = new Hono()
const PORT = Number(process.env.PORT ?? 3001)

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-request-id'],
}))
app.use('*', honoLogger())

app.get('/health', (c) => c.json({ ok: true }))

/**
 * POST /generate
 * Body: { message: string }
 *
 * Returns an SSE stream of tokens from the corpus, then a done event.
 * The Cloudflare Worker reads this stream and pushes each token into the DO.
 */
app.post('/generate', async (c) => {
  const { message } = await c.req.json<{ message: string }>()
  if (!message?.trim()) return c.json({ error: 'message required' }, 400)

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const sse = (event: string, data: object) =>
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        )

      for await (const token of generateTokens(message)) {
        sse('token', { content: token })
      }

      sse('done', {})
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
})

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Backend server  http://localhost:${PORT}`)
})
