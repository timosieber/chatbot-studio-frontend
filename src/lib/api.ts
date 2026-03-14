import { account } from './appwrite'

// In Development, call the backend directly via VITE_BACKEND_URL (e.g. http://localhost:4000)
// In Production (Railway), use same-origin relative /api path (served by the proxy server)
const isDev = import.meta.env.DEV
const BACKEND_URL = isDev ? (import.meta.env.VITE_BACKEND_URL || 'http://localhost:4000') : ''

let cachedJwt: string | null = null
let jwtExpiration = 0
let activeTokenRequest: Promise<string> | null = null

async function getValidToken(): Promise<string> {
  const now = Date.now()
  if (cachedJwt && now < jwtExpiration) {
    return cachedJwt
  }

  if (activeTokenRequest) {
    return activeTokenRequest
  }

  activeTokenRequest = (async () => {
    try {
      const { jwt } = await account.createJWT()
      cachedJwt = jwt
      jwtExpiration = Date.now() + 10 * 60 * 1000
      return jwt
    } finally {
      activeTokenRequest = null
    }
  })()

  return activeTokenRequest
}

export type UserStatus = 'WAITLIST' | 'APPROVED'

export interface UserInfo {
  id: string
  email: string
  status: UserStatus
  createdAt: string
}

export async function getUserInfo(): Promise<UserInfo> {
  const res = await fetch(`${BACKEND_URL}/api/user/me`, {
    headers: await authHeaders(),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Laden der Benutzerinformationen (${res.status})`)
  return res.json()
}

export interface Chatbot {
  id: string
  userId: string
  name: string
  description?: string | null
  systemPrompt?: string | null
  logoUrl?: string | null
  websiteUrl?: string | null
  allowedDomains: string[]
  theme?: Record<string, unknown> | null
  model?: string | null
  status: 'ACTIVE' | 'DRAFT' | 'PAUSED' | 'ARCHIVED'
  createdAt: string
  updatedAt: string
}

async function authHeaders() {
  const jwt = await getValidToken()
  return {
    Authorization: `Bearer ${jwt}`,
    'Content-Type': 'application/json',
  }
}

export async function listChatbots(): Promise<Chatbot[]> {
  const res = await fetch(`${BACKEND_URL}/api/chatbots`, {
    headers: await authHeaders(),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Laden der Chatbots (${res.status})`)
  return res.json()
}

export async function createChatbot(input: { name: string; description?: string; systemPrompt?: string; logoUrl?: string; websiteUrl?: string; allowedDomains: string[]; model?: string; status?: Chatbot['status'] }): Promise<Chatbot> {
  const res = await fetch(`${BACKEND_URL}/api/chatbots`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Erstellen des Chatbots (${res.status})`)
  return res.json()
}

export async function updateChatbot(id: string, input: Partial<{ name: string; description?: string; systemPrompt?: string; logoUrl?: string; websiteUrl?: string; theme?: Record<string, unknown>; model?: string; status?: Chatbot['status'] }>): Promise<Chatbot> {
  const res = await fetch(`${BACKEND_URL}/api/chatbots/${id}`, {
    method: 'PATCH',
    headers: await authHeaders(),
    body: JSON.stringify(input),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Aktualisieren des Chatbots (${res.status})`)
  return res.json()
}

export async function deleteChatbot(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/chatbots/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Löschen des Chatbots (${res.status})`)
}

export async function createSession(chatbotId: string): Promise<{ sessionId: string; token: string; expiresAt: string; chatbotId: string; chatbot?: Pick<Chatbot, 'id' | 'name' | 'theme'> }> {
  const res = await fetch(`${BACKEND_URL}/api/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatbotId }),
  })
  if (!res.ok) throw new Error(`Fehler beim Erstellen der Session (${res.status})`)
  return res.json()
}

export type ChatSource = {
  content: string
  metadata: Record<string, unknown>
  score: number
}

type RagClaim = {
  text: string
  supporting_chunk_ids: string[]
}

type RagSource = {
  chunk_id: string
  title: string
  canonical_url: string | null
  original_url: string | null
  uri: string | null
  page_no: number | null
  start_offset: number
  end_offset: number
}

type RagResponse = {
  claims: RagClaim[]
  unknown: boolean
  reason?: string
  debug_id: string
  context_truncated: boolean
  sources: RagSource[]
}

export type SendMessageResponse = {
  sessionId: string | null
  answer: string
  context?: unknown
  sources?: ChatSource[]
}

export async function sendMessage(params: {
  sessionId: string
  token: string
  message: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<SendMessageResponse> {
  const res = await fetch(`${BACKEND_URL}/api/chat/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${params.token}` },
    body: JSON.stringify({ sessionId: params.sessionId, message: params.message, history: params.history }),
  })
  if (!res.ok) throw new Error(`Fehler beim Senden der Nachricht (${res.status})`)

  const raw = (await res.json()) as { sessionId: string | null; rag: RagResponse }

  // Transform RAG response to the expected SendMessageResponse format
  // For unknown responses, use claims if available (natural off-topic responses), otherwise fallback to reason
  const answer = raw.rag.unknown
    ? (raw.rag.claims.length > 0 ? raw.rag.claims.map((c) => c.text).join('\n\n') : raw.rag.reason || 'Das kann ich leider nicht beantworten.')
    : raw.rag.claims.map((c) => c.text).join('\n\n')

  const sources: ChatSource[] = raw.rag.sources.map((s) => ({
    content: '',
    metadata: {
      chunk_id: s.chunk_id,
      title: s.title,
      sourceUrl: s.canonical_url || s.original_url || s.uri || '',
      uri: s.uri || '',
      page_no: s.page_no,
    },
    score: 1, // RAG sources don't have scores, default to 1
  }))

  return {
    sessionId: raw.sessionId,
    answer,
    sources,
  }
}

// Knowledge Sources API
export interface KnowledgeSource {
  id: string
  chatbotId: string
  type: 'URL' | 'TEXT' | 'FILE'
  label: string
  uri?: string | null
  status: 'PENDING' | 'READY' | 'FAILED'
  metadata?: Record<string, unknown> | null
  createdAt: string
  updatedAt: string
}

export interface ScrapeResponse {
  sources: Array<{
    id: string
    label: string
    chunks: number
  }>
  pagesScanned: number
}

export async function scrapeWebsite(input: {
  chatbotId: string
  startUrls: string[]
  maxDepth?: number
  maxPages?: number
}): Promise<ScrapeResponse> {
  const res = await fetch(`${BACKEND_URL}/api/knowledge/sources/scrape`, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(input),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Scrapen der Website (${res.status})`)
  return res.json()
}

export async function listKnowledgeSources(chatbotId: string): Promise<KnowledgeSource[]> {
  const res = await fetch(`${BACKEND_URL}/api/knowledge/sources?chatbotId=${chatbotId}`, {
    headers: await authHeaders(),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Laden der Wissensquellen (${res.status})`)
  return res.json()
}

export async function deleteKnowledgeSource(id: string): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/api/knowledge/sources/${id}`, {
    method: 'DELETE',
    headers: await authHeaders(),
    credentials: 'include',
  })
  if (!res.ok) throw new Error(`Fehler beim Löschen der Wissensquelle (${res.status})`)
}

export type ProvisioningEvent =
  | { type: 'snapshot'; chatbotId: string; chatbotStatus: Chatbot['status'] | null; pendingSources: number; failedSources: number; updatedAt: string | null }
  | { type: 'started'; chatbotId: string }
  | { type: 'completed'; chatbotId: string; status: 'ACTIVE' }
  | { type: 'failed'; chatbotId: string; status: Chatbot['status'] | string; error?: string }

// ============================================================================
// Voice API (Speech-to-Text & Text-to-Speech)
// ============================================================================

export interface TranscriptionResult {
  text: string
  language?: string
  duration?: number
}

export interface VoiceMessageResponse {
  sessionId: string
  transcription: TranscriptionResult
  rag: RagResponse
  audio: string | null // Base64 encoded audio
  audioContentType: string | null
}

/**
 * Send a voice message (audio → transcription → chat → optional TTS)
 */
export async function sendVoiceMessage(params: {
  sessionId: string
  token: string
  audioBlob: Blob
  synthesize?: boolean
}): Promise<VoiceMessageResponse> {
  const path = `${BACKEND_URL}/api/voice/message`
  const searchParams = new URLSearchParams({
    sessionId: params.sessionId,
    synthesize: String(params.synthesize ?? true),
  })

  const res = await fetch(`${path}?${searchParams.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': params.audioBlob.type,
      Authorization: `Bearer ${params.token}`,
    },
    body: params.audioBlob,
  })
  if (!res.ok) {
    const errorText = await res.text().catch(() => '')
    throw new Error(`Voice-Nachricht fehlgeschlagen (${res.status}): ${errorText}`)
  }
  return res.json()
}

/**
 * Synthesize text to speech
 */
export async function synthesizeSpeech(params: {
  sessionId: string
  token: string
  text: string
  voice?: 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer'
}): Promise<Blob> {
  const path = `${BACKEND_URL}/api/voice/synthesize`
  const searchParams = new URLSearchParams({ sessionId: params.sessionId })

  const res = await fetch(`${path}?${searchParams.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
    },
    body: JSON.stringify({ text: params.text, voice: params.voice }),
  })
  if (!res.ok) throw new Error(`Sprachsynthese fehlgeschlagen (${res.status})`)
  return res.blob()
}

// ============================================================================
// Provisioning Events Stream
// ============================================================================

export async function streamProvisioningEvents(params: {
  chatbotId: string
  onEvent: (event: ProvisioningEvent) => void
  signal?: AbortSignal
}): Promise<void> {
  const url = `${BACKEND_URL}/api/knowledge/provisioning/stream?chatbotId=${encodeURIComponent(params.chatbotId)}`
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      ...(await authHeaders()),
      Accept: 'text/event-stream',
    },
    credentials: 'include',
    signal: params.signal,
  })

  if (!res.ok || !res.body) {
    throw new Error(`Provisioning-Stream konnte nicht gestartet werden (${res.status})`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder('utf-8')

  let buffer = ''
  let eventName: string | null = null
  let dataLines: string[] = []

  const flush = () => {
    if (!dataLines.length) return
    if (eventName !== 'provisioning') {
      eventName = null
      dataLines = []
      return
    }
    const payload = dataLines.join('\n')
    eventName = null
    dataLines = []
    try {
      const parsed = JSON.parse(payload) as ProvisioningEvent
      params.onEvent(parsed)
    } catch {
      // ignore invalid payloads
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // Parse SSE frames: events separated by a blank line
    while (true) {
      const idx = buffer.indexOf('\n\n')
      if (idx === -1) break
      const rawEvent = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 2)

      const lines = rawEvent.split('\n').map((l) => l.replace(/\r$/, ''))
      for (const line of lines) {
        if (!line || line.startsWith(':')) continue
        if (line.startsWith('event:')) {
          eventName = line.slice('event:'.length).trim()
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice('data:'.length).trimStart())
        }
      }
      flush()
    }
  }
}
