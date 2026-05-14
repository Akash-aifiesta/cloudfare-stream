# Task Ticket: Implement Resumable Streaming Chat System on Cloudflare Edge

## Objective

Build a resumable streaming chat infrastructure using:

* [Cloudflare Workers](https://workers.cloudflare.com/?utm_source=chatgpt.com) as API gateway + streaming layer
* [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/?utm_source=chatgpt.com) as authoritative stream/session coordinator
* [Cloudflare Load Balancing](https://www.cloudflare.com/application-services/products/load-balancing/?utm_source=chatgpt.com) for ingress and failover
* SSE (Server-Sent Events) for token streaming
* Client-side automatic reconnect + resume support

The system must support:

* live token streaming
* interrupted connection recovery
* replaying missed chunks
* reconnecting to ongoing streams
* deterministic ordered delivery

---

# High-Level Architecture

```txt id="4r0y1z"
Client
  ↓
Cloudflare Proxy + LB
  ↓
Cloudflare Worker API Gateway
  ↓
Durable Object (1 DO per chat session)
  ↓
Simulated Streaming Engine
```

---

# Core Requirements

## Streaming Requirements

### `/stream`

Starts a new streaming chat session.

### `/resume`

Reconnects to an existing stream and replays missed chunks.

### Behavior

If the client disconnects while stream generation is still running:

* generation MUST continue inside the Durable Object
* emitted chunks MUST be buffered
* reconnecting client MUST:

  * receive missed chunks
  * continue receiving live chunks

---

# Architecture Rules

## CRITICAL RULE

The Durable Object MUST own:

* stream lifecycle
* sequence numbering
* chunk buffering
* replay state
* active client connections

Workers MUST remain stateless.

DO NOT generate stream chunks directly inside Workers.

---

# API Contracts

# 1. POST /stream

## Request

```json id="g2q5ja"
{
  "chatId": "optional-client-generated-id",
  "message": "Explain quantum computing"
}
```

## Response

SSE stream:

```txt id="fd7k2m"
Content-Type: text/event-stream
```

Example:

```txt id="wj5v0k"
event: token
data: {"seq":1,"content":"Quantum"}

event: token
data: {"seq":2,"content":"computing"}
```

---

# 2. POST /resume

## Request

```json id="h7v8ok"
{
  "chatId": "abc123",
  "lastSequence": 24
}
```

## Behavior

Server MUST:

1. replay chunks with `seq > lastSequence`
2. reconnect client to live stream
3. continue streaming new chunks

---

# Streaming Protocol

Use SSE exclusively.

## Required Events

### token

```txt id="yl9c4d"
event: token
data: {"seq":12,"content":"hello"}
```

### replay_complete

Sent after backlog replay completes.

```txt id="1n3o7f"
event: replay_complete
data: {}
```

### done

```txt id="6k2d9e"
event: done
data: {}
```

### ping

Heartbeat event every ~15s.

```txt id="q3m8zj"
event: ping
data: {}
```

---

# Durable Object Design

## Namespace Strategy

```txt id="z8r2ua"
chat:{chatId}
```

One Durable Object per chat session.

---

# Durable Object Responsibilities

The DO MUST:

* generate simulated tokens
* maintain ordered sequence numbers
* store replay buffer
* track active stream state
* support reconnect/replay
* handle multiple reconnects safely
* serialize state updates

---

# Durable Object State Model

## In-Memory State

```ts id="y7l3dn"
{
  currentSequence: number,
  streamStatus: "streaming" | "completed",
  activeClients: Set<ClientConnection>,
  chunkBuffer: StreamChunk[],
  startedAt: number,
  updatedAt: number
}
```

---

# Persistent State

Persist replay buffer using Durable Object storage.

Required persisted data:

```ts id="0x9fvu"
{
  chunks,
  currentSequence,
  completionState,
  timestamps
}
```

---

# Replay Logic

## On Resume

Given:

```json id="2s6twl"
{
  "chatId": "abc",
  "lastSequence": 42
}
```

The DO MUST:

1. replay all chunks where `seq > 42`
2. send `replay_complete`
3. attach connection to live stream
4. continue streaming future chunks

---

# Simulated Stream Engine

Implement simulated token generation.

Example:

```ts id="b5e1yf"
tokens = ["Hello", "world", "this", "is", "streaming"]
```

Emit:

* one token every 50–150ms
* sequential ordering guaranteed

---

# Client Requirements

Implement a browser client demonstrating:

* live streaming
* disconnect handling
* automatic resume
* replay visualization

---

# Client Features

## Stream Start

* submit chat prompt
* call `/stream`

## Sequence Tracking

Client MUST persist:

* `chatId`
* `lastSequenceReceived`

Use:

* in-memory
* localStorage fallback

---

# Reconnect Logic

On:

* network disconnect
* SSE interruption
* tab sleep/wake

Client MUST:

1. reconnect automatically
2. call `/resume`
3. provide `lastSequence`
4. continue rendering seamlessly

---

# Client UI Requirements

## Required UI

### Chat Window

Render streamed tokens incrementally.

### Connection Status

Show:

* connected
* reconnecting
* resumed
* completed

### Replay Indicator

Optional UI indicator during replay.

---

# Edge Cases

## MUST Handle

### Disconnect During Active Stream

Replay missing chunks + continue live stream.

### Disconnect After Completion

Replay remaining chunks + emit `done`.

### Duplicate Resume Requests

No duplicated chunk delivery.

### Late Resume

If stream expired:

```json id="2sxlpu"
{
  "error": "stream_expired"
}
```

---

# Stream Retention Rules

| State           | Retention             |
| --------------- | --------------------- |
| Active stream   | in-memory             |
| Replay buffer   | persisted             |
| Resume window   | 30 mins               |
| Expired streams | cleanup automatically |

---

# Worker Responsibilities

Workers MUST:

* validate requests
* route to correct DO
* handle auth hooks
* set SSE headers
* manage observability/logging

Workers MUST NOT:

* own stream state
* generate chunks
* manage replay buffers

---

# Reliability Requirements

## Heartbeats

Emit SSE `ping` event every 15 seconds.

## Exactly-Once Semantics

Client MUST dedupe using `seq`.

## Ordering

Strictly increasing sequence numbers required.

---

# Observability

Implement:

* structured logs
* request IDs
* reconnect metrics
* replay metrics
* stream duration metrics

---

# Suggested File Structure

```txt id="x6f0kj"
/apps
  /worker
    index.ts
    routes/
      stream.ts
      resume.ts
    durable/
      ChatSessionDO.ts
    lib/
      sse.ts
      replay.ts

  /client
    src/
      components/
      hooks/
      services/
      state/
```

---

# Technical Requirements

## Runtime

* TypeScript
* Cloudflare Workers runtime
* Durable Objects
* SSE

## Client

* React or Next.js
* Native EventSource OR fetch streaming

---

# Acceptance Criteria

## Streaming

* stream emits ordered chunks

## Resume

* reconnect replays missed chunks

## Live Continuation

* resumed client rejoins active stream

## Persistence

* replay survives DO restart

## UX

* reconnect appears seamless

## Reliability

* no duplicated chunks
* no ordering violations

---

# Implementation Deliverables

## Backend

* Worker gateway
* Durable Object implementation
* SSE utilities
* replay engine
* simulated token engine

## Client

* streaming UI
* reconnect logic
* resume implementation
* sequence tracking

## Documentation

* architecture notes
* reconnect flow
* local dev instructions
* deployment instructions

---

# Stretch Goals (Optional)

* WebSocket support
* stream cancellation endpoint
* multi-device resume
* persistent chat history
* LLM provider integration
* backpressure handling
* adaptive retry strategy

---

# Important Implementation Notes

## DO MUST Continue Stream After Disconnect

This is mandatory.

Disconnecting the client MUST NOT stop generation.

The stream lifecycle belongs entirely to the Durable Object.

---

# Expected End-to-End Flow

```txt id="8j2rwh"
1. Client calls /stream
2. DO begins token generation
3. Client receives seq 1..50
4. Network disconnect occurs
5. DO continues generating seq 51..80
6. Client reconnects via /resume(lastSequence=50)
7. DO replays 51..80
8. Client rejoins live stream
9. Stream completes
```
