import { DurableObject } from 'cloudflare:workers'
import { log } from '../lib/logger'
import type { Env } from '../types'

const STREAM_TTL_MS = 30 * 60 * 1000

export class ChatSessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => this.migrate())
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS session_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chunks (
        seq     INTEGER PRIMARY KEY,
        content TEXT    NOT NULL,
        ts      INTEGER NOT NULL
      );
    `)
  }

  // ── RPC: init a new session ────────────────────────────────────────────────
  async init(chatId: string): Promise<void> {
    const sql = this.ctx.storage.sql
    sql.exec(`DELETE FROM chunks`)
    sql.exec(`DELETE FROM session_meta`)
    sql.exec(`INSERT INTO session_meta VALUES ('chatId',    ?)`, chatId)
    sql.exec(`INSERT INTO session_meta VALUES ('startedAt', ?)`, String(Date.now()))
    sql.exec(`INSERT INTO session_meta VALUES ('status',    'streaming')`)
    sql.exec(`INSERT INTO session_meta VALUES ('seq',       '0')`)
    await this.ctx.storage.setAlarm(Date.now() + STREAM_TTL_MS)
    log({ event: 'session_init', chatId })
  }

  // ── RPC: push one token, returns the assigned seq ─────────────────────────
  async pushToken(content: string): Promise<number> {
    const sql = this.ctx.storage.sql
    const row = sql.exec<{ value: string }>(
      `SELECT value FROM session_meta WHERE key = 'seq'`
    ).one()
    const seq = Number(row.value) + 1
    // No await between these writes — coalesced into one atomic transaction
    sql.exec(`UPDATE session_meta SET value = ? WHERE key = 'seq'`, String(seq))
    sql.exec(`INSERT INTO chunks (seq, content, ts) VALUES (?, ?, ?)`, seq, content, Date.now())
    return seq
  }

  // ── RPC: signal stream complete ────────────────────────────────────────────
  async markDone(): Promise<void> {
    this.ctx.storage.sql.exec(
      `UPDATE session_meta SET value = 'completed' WHERE key = 'status'`
    )
    const seq = this.ctx.storage.sql.exec<{ value: string }>(
      `SELECT value FROM session_meta WHERE key = 'seq'`
    ).one().value
    log({ event: 'stream_done', totalSeq: Number(seq) })
  }

  // ── RPC: return next batch of chunks ──────────────────────────────────────
  async poll(afterSeq: number): Promise<{
    chunks: Array<{ seq: number; content: string }>
    done: boolean
  }> {
    const sql = this.ctx.storage.sql
    const chunks = sql.exec<{ seq: number; content: string }>(
      `SELECT seq, content FROM chunks WHERE seq > ? ORDER BY seq ASC LIMIT 500`,
      afterSeq
    ).toArray()

    const statusRows = sql.exec<{ value: string }>(
      `SELECT value FROM session_meta WHERE key = 'status'`
    ).toArray()

    const done = statusRows.length > 0 && statusRows[0]!.value === 'completed'
    return { chunks, done }
  }

  // ── RPC: check session validity ───────────────────────────────────────────
  async isValid(): Promise<{ valid: boolean; expired: boolean }> {
    const rows = this.ctx.storage.sql.exec<{ value: string }>(
      `SELECT value FROM session_meta WHERE key = 'startedAt'`
    ).toArray()
    if (rows.length === 0) return { valid: false, expired: false }
    const startedAt = Number(rows[0]!.value)
    if (Date.now() - startedAt > STREAM_TTL_MS) return { valid: false, expired: true }
    return { valid: true, expired: false }
  }

  // ── Alarm: TTL cleanup ─────────────────────────────────────────────────────
  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec(`DELETE FROM chunks; DELETE FROM session_meta;`)
    log({ event: 'do_alarm_cleanup' })
  }
}
