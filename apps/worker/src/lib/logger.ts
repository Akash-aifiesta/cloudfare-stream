interface LogEntry {
  event: string
  requestId?: string
  chatId?: string
  seq?: number
  lastSequence?: number
  replayCount?: number
  activeClients?: number
  totalSeq?: number
  durationMs?: number
  error?: string
  [key: string]: unknown
}

export function log(entry: LogEntry): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }))
}
