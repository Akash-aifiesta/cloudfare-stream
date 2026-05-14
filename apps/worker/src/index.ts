import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { streamRoute } from './routes/stream'
import { resumeRoute } from './routes/resume'
import { pushRoute, startRoute } from './routes/push'
import type { Env } from './types'

export { ChatSessionDO } from './durable/ChatSessionDO'

const app = new Hono<{ Bindings: Env }>()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-request-id'],
}))

app.use('*', honoLogger())

// Client-facing SSE endpoints
app.post('/stream', streamRoute)
app.post('/resume', resumeRoute)

// Server-push endpoints (called by backend/LLM service)
app.post('/start', startRoute)
app.post('/push', pushRoute)

app.all('*', (c) => c.json({ error: 'not_found' }, 404))

export default app
