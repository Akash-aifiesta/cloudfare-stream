# Resumable Streaming Chat — Cloudflare Edge POC

A production-grade proof-of-concept for **resumable AI token streaming** on Cloudflare's edge. Clients can disconnect at any point and reconnect to replay missed chunks and continue the live stream — with no lost tokens, no duplicates, and strict ordering.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  CLIENT (Browser)                           │
│  • EventSource / fetch streaming            │
│  • Tracks chatId + lastSequenceReceived     │
│  • Auto-reconnects via /resume              │
└──────────────┬──────────────────────────────┘
               │ HTTP / SSE
               ▼
┌─────────────────────────────────────────────┐
│  CLOUDFLARE WORKER (Stateless Gateway)      │
│  • Routes requests                          │
│  • Delivers SSE to client                   │
│  • Pipes backend stream into DO             │
│  • No stream state of its own               │
└──────────┬─────────────────┬────────────────┘
           │ RPC             │ fetch (SSE)
           ▼                 ▼
┌─────────────────┐  ┌──────────────────────────┐
│  DURABLE OBJECT │  │  BACKEND SERVER          │
│  (ChatSession)  │  │  (Node.js + Hono)        │
│                 │  │                          │
│  SQLite storage │  │  POST /generate          │
│  Sequence nums  │  │  Emits SSE token stream  │
│  Replay buffer  │  │  (LLM stub today,        │
│  TTL / alarm    │  │   real LLM in prod)      │
└─────────────────┘  └──────────────────────────┘
```

**Key design rule:** The Durable Object owns all stream state. The Worker is stateless and purely routes/delivers. Generation continues inside the DO even after the client disconnects.

---

## Project Structure

```
poc1/
├── apps/
│   ├── worker/                    # Cloudflare Worker + Durable Object
│   │   ├── wrangler.toml          # Worker config, DO binding, SQLite migration
│   │   └── src/
│   │       ├── index.ts           # Hono app, route registration, CORS
│   │       ├── types.ts           # Env interface
│   │       ├── durable/
│   │       │   └── ChatSessionDO.ts   # DO: SQLite schema, RPC methods, TTL alarm
│   │       ├── lib/
│   │       │   ├── do-stream.ts   # streamFromDO() + pipeBackendToDO()
│   │       │   ├── sse.ts         # formatSSE() utility
│   │       │   └── logger.ts      # Structured JSON logging
│   │       └── routes/
│   │           ├── stream.ts      # POST /stream
│   │           ├── resume.ts      # POST /resume
│   │           └── push.ts        # POST /push  POST /start
│   │
│   └── server/                    # Backend token server (Node.js)
│       ├── railway.toml           # Railway deployment config
│       └── src/
│           ├── index.ts           # Hono server on :3001, POST /generate
│           └── token-generator.ts # Async generator, 700-token corpus, 50–150ms/token
│
├── poc.md                         # Original requirements specification
└── pnpm-workspace.yaml
```

---

## How It Works

### Fresh Stream

```
1.  Client: POST /stream { chatId?, message }
2.  Worker: generates chatId, calls DO.init(chatId)
3.  Worker: starts two background tasks via ctx.waitUntil:
      a. pipeBackendToDO() — fetches POST /generate from backend,
         reads SSE token events, batches 10 tokens, pushes via
         DO.pushTokenBatch(), calls DO.markDone() at end
      b. streamFromDO()    — polls DO.poll(cursor) every 200ms,
         writes SSE token events to the client's TransformStream
4.  Worker: returns streaming Response immediately
5.  Client: receives "start" event then sequential "token" events
6.  Stream ends: DO status → "completed", Worker sends "done", closes stream
```

### Disconnect and Resume

```
1.  Client receives tokens seq 1..50, network fails, stores:
      localStorage.chatId = "abc123"
      localStorage.lastSeq = 50

2.  [Background] Worker continues pipeBackendToDO():
      DO accumulates tokens seq 51..120, marks done

3.  Client reconnects: POST /resume { chatId: "abc123", lastSequence: 50 }

4.  Worker validates session (DO.isValid()), starts streamFromDO(lastSeq=50, isResume=true):

    ── Replay phase ──────────────────────────────────
    Poll DO for all chunks where seq > 50
    Send each token event (seq 51..120)
    When buffer empty → send "replay_complete"

    ── If already done ───────────────────────────────
    Send "done", close → client has full response

    ── If still live ─────────────────────────────────
    Continue polling for new tokens, send as they arrive
    Send "done" when stream completes

5.  Client: seamless continuation — no gaps, no duplicates
```

---

## API Reference

### `POST /stream`

Start a new chat stream.

**Request**
```json
{ "chatId": "optional-uuid", "message": "Explain distributed systems" }
```

**Response** — `text/event-stream`
```
event: start
data: {"chatId":"abc123"}

event: token
data: {"seq":1,"content":"Distributed"}

event: ping
data: {}

event: done
data: {}
```

---

### `POST /resume`

Reconnect to an existing stream and replay missed chunks.

**Request**
```json
{ "chatId": "abc123", "lastSequence": 42 }
```

**Response** — `text/event-stream`
```
event: token
data: {"seq":43,"content":"systems"}

event: replay_complete
data: {}

event: token
data: {"seq":44,"content":"are"}

event: done
data: {}
```

**Errors**
```json
{ "error": "stream_expired" }   // 404 — TTL elapsed
{ "error": "not_found" }        // 404 — unknown chatId
```

---

### `POST /push`

Push a single token directly from an external service (server-push workflow).

**Request**
```json
{ "chatId": "abc123", "content": "token text", "done": false }
```

**Response**
```json
{ "ok": true, "seq": 5 }
```

---

### `POST /start`

Pre-initialize a session before streaming begins.

**Request**
```json
{ "chatId": "optional-uuid" }
```

**Response**
```json
{ "ok": true, "chatId": "abc123" }
```

---

## SSE Event Protocol

| Event            | When sent                                      | Data                          |
|------------------|------------------------------------------------|-------------------------------|
| `start`          | First event on a fresh `/stream`               | `{ chatId }`                  |
| `token`          | Each chunk delivered                           | `{ seq: number, content: string }` |
| `replay_complete`| After buffered chunks drained on `/resume`     | `{}`                          |
| `done`           | Stream completed                               | `{}`                          |
| `ping`           | Every 15 s when no tokens arrive (keep-alive) | `{}`                          |

Clients deduplicate using `seq` — strictly increasing integers guarantee exactly-once delivery even across multiple reconnects.

---

## Durable Object Design

**Namespace:** `chat:{chatId}` — one DO instance per session.

### SQLite Schema

```sql
-- Session metadata (key/value)
CREATE TABLE session_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Rows: chatId, startedAt, status ('streaming'|'completed'), seq (current counter)

-- Replay buffer
CREATE TABLE chunks (
  seq     INTEGER PRIMARY KEY,   -- strictly increasing, never reused
  content TEXT    NOT NULL,
  ts      INTEGER NOT NULL
);
```

### RPC Methods

| Method | Description |
|--------|-------------|
| `init(chatId)` | Reset tables, set status=streaming, schedule TTL alarm |
| `pushToken(content)` | Insert one token, return assigned seq |
| `pushTokenBatch(tokens[])` | Insert N tokens in one RPC call, return final seq |
| `poll(afterSeq)` | Return `{ chunks, done }` — chunks where seq > afterSeq (max 500) |
| `markDone()` | Set status=completed |
| `isValid()` | Return `{ valid, expired }` based on startedAt + 30-min TTL |
| `alarm()` | TTL cleanup — deletes all rows |

### Session Lifecycle

```
init() → [pushTokenBatch() × N] → markDone()
                                        ↓
                              alarm fires at +30min
                                        ↓
                              DELETE FROM chunks + session_meta
```

---

## Performance Improvements

Two optimizations were made over the initial implementation to stay within Cloudflare Workers' **1000 subrequests per invocation** limit for a typical 2-minute, ~700-token stream.

### 1. Batched Token Writes (`pushTokenBatch`)

**Before:** Each token was pushed individually via `DO.pushToken(content)` — one RPC call per token.

**After:** Tokens are accumulated in a `pending[]` buffer and flushed in batches of 10 via `DO.pushTokenBatch(tokens[])`.

```
PUSH_BATCH_SIZE = 10

Before: ~700 tokens → 700 pushToken RPC calls
After:  ~700 tokens →  70 pushTokenBatch RPC calls   (10× reduction)
```

The `pushTokenBatch` implementation reads the current sequence once, inserts all N rows in a tight loop (no intermediate awaits so SQLite coalesces them into one transaction), then updates the seq counter once — keeping writes atomic and fast.

### 2. Tuned Poll Interval (50ms → 200ms)

**Before:** The SSE delivery loop polled the DO every 50ms.

**After:** Poll interval raised to 200ms.

```
POLL_INTERVAL_MS = 200  (was 50)

For a 112-second stream:
  Before: 112 000 / 50  = 2 240 poll calls
  After:  112 000 / 200 =   560 poll calls   (4× reduction)
```

### Combined Budget Impact

```
Worst-case subrequests for a 2-minute, 700-token stream:

  pushTokenBatch calls:  70
  poll calls:           560
  init + markDone:        2
  isValid:                1
  ────────────────────────
  Total:                633   (comfortably under the 1000 limit)

Without optimizations:
  pushToken calls:      700
  poll calls:          2240
  Total:               2943   (2.9× over the limit — would fail)
```

These two changes together make the system viable for production workloads on Cloudflare Workers without hitting platform limits.

---

## Local Development

### Prerequisites

- Node.js 18+
- pnpm 8+
- Cloudflare account (for `wrangler dev`)

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start the backend token server

```bash
cd apps/server
pnpm dev
# Hono server running on http://localhost:3001
# Endpoint: POST /generate → SSE token stream
```

### 3. Configure the Worker environment

```bash
# apps/worker/.dev.vars  (create if missing)
BACKEND_URL=http://localhost:3001
```

### 4. Start the Worker

```bash
cd apps/worker
pnpm dev
# wrangler dev starts at http://localhost:8787
```

### 5. Test a stream

```bash
# Start a stream
curl -N -X POST http://localhost:8787/stream \
  -H "Content-Type: application/json" \
  -d '{"message": "hello"}' \
  --no-buffer

# Resume (replace abc123 and 42 with real values)
curl -N -X POST http://localhost:8787/resume \
  -H "Content-Type: application/json" \
  -d '{"chatId":"abc123","lastSequence":42}' \
  --no-buffer
```

---

## Deployment

### Worker (Cloudflare)

```bash
cd apps/worker
pnpm deploy
# Deploys resumable-stream-worker to your Cloudflare account
```

Set the production environment variable via Wrangler:

```bash
wrangler secret put BACKEND_URL
# Enter your deployed backend URL when prompted
```

### Backend Server (Railway)

The `apps/server/railway.toml` and `apps/server/nixpacks.toml` are already configured for Railway.

1. Push the repo to GitHub
2. Create a new Railway project → "Deploy from GitHub repo"
3. Select the `apps/server` directory as the root
4. Railway will auto-detect nixpacks and deploy the Hono server
5. Copy the Railway service URL and set it as `BACKEND_URL` in your Worker secrets

---

## Environment Variables

| Variable | Where | Description |
|----------|-------|-------------|
| `BACKEND_URL` | Worker (`apps/worker/.dev.vars` / Wrangler secret) | Base URL of the backend token server |
| `PORT` | Backend server | Port override (default: `3001`) |

---

## Observability

All key events emit structured JSON logs via `lib/logger.ts`:

| Event | Emitted when |
|-------|-------------|
| `session_init` | DO initialized for a new chat |
| `backend_pipe_done` | Backend stream fully consumed |
| `stream_delivered` | Fresh SSE stream closed (with `finalSeq`) |
| `resume_delivered_complete` | Resume SSE closed after replay |
| `stream_done` | DO marked stream as completed |
| `do_alarm_cleanup` | TTL alarm fired, storage cleaned up |
| `backend_pipe_error` | Error reading backend stream |
| `stream_error` | Error in SSE delivery loop |

Each log line includes `requestId` (UUID per request) and `chatId` for correlation.

---

## Stretch Goals / Future Work

From the original specification:

- **Real LLM integration** — Replace the token corpus in `apps/server` with an OpenAI/Anthropic streaming API call; the rest of the pipeline is unchanged
- **Browser client** — React/Next.js UI with auto-reconnect, sequence tracking, replay indicator, and connection status display
- **WebSocket support** — Replace SSE polling with DO WebSocket push for lower latency
- **Stream cancellation** — `POST /cancel { chatId }` endpoint to abort generation mid-stream
- **Multi-device resume** — Multiple clients resuming the same `chatId` simultaneously
- **Persistent chat history** — Store completed sessions beyond the 30-minute TTL in R2 or D1
- **Backpressure handling** — Slow-consumer detection and adaptive batch sizes
- **Adaptive retry strategy** — Exponential backoff on the client reconnect loop
