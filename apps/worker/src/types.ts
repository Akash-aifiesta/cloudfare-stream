import type { ChatSessionDO } from './durable/ChatSessionDO'

export interface Env {
  CHAT_SESSION: DurableObjectNamespace<ChatSessionDO>
  BACKEND_URL: string
}
