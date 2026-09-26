import { Lock } from './lock.ts'

// En Docker, "localhost" désigne le conteneur lui-même, pas l'hôte qui fait
// tourner Ollama — on rend donc l'URL surchargeable via l'environnement
// (ex. http://host.docker.internal:11434/api/chat, voir Dockerfile).
export const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434/api/chat'
export const MODEL = process.env.OLLAMA_MODEL ?? 'gemma4:26b'
// Délai d'inactivité (et non durée totale) : réarmé à chaque morceau reçu, il
// couvre le chargement du modèle sans couper une longue génération qui avance.
export const IDLE_TIMEOUT_MS = Number(process.env.OLLAMA_IDLE_TIMEOUT_MS ?? 120_000)
export const SYSTEM_PROMPT = 'Réponds de façon brève et factuelle.'

export type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export type Chunk =
  | { type: 'text'; content: string }
  | { type: 'done'; duration_ms: number; eval_count: number }

type OllamaLine = {
  message?: { content?: string }
  done?: boolean
  total_duration?: number
  eval_count?: number
  error?: string
}

// Un unique historique de conversation partagé par tous les visiteurs
// (single-tenant) : Ollama n'a pas de notion de session, donc c'est nous qui
// renvoyons tout l'historique à chaque appel.
let history: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]

// L'appelant (app.ts) tient ce verrou pendant tout un tour : streamChat() et
// resetHistory() ne le reprennent pas eux-mêmes.
export const lock = new Lock()

export function getHistory(): readonly Message[] {
  return history
}

/** Vide l'historique partagé (bouton "Nouvelle conversation" du frontend). */
export function resetHistory(): void {
  history = [{ role: 'system', content: SYSTEM_PROMPT }]
}

export type StreamChatOptions = {
  signal?: AbortSignal
  idleTimeoutMs?: number
}

/**
 * Envoie `message` à Ollama et streame les morceaux de réponse.
 *
 * Contrairement à la version Python, l'historique n'est modifié qu'une fois la
 * réponse complète reçue : si Ollama échoue ou si le client se déconnecte en
 * cours de route, aucun message utilisateur orphelin ne reste dans _history.
 */
export async function* streamChat(
  message: string,
  { signal, idleTimeoutMs = IDLE_TIMEOUT_MS }: StreamChatOptions = {},
): AsyncGenerator<Chunk> {
  const userMessage: Message = { role: 'user', content: message }

  const idle = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const armIdleTimer = () => {
    clearTimeout(timer)
    timer = setTimeout(
      () => idle.abort(new Error(`Ollama n'a rien envoyé depuis ${idleTimeoutMs} ms`)),
      idleTimeoutMs,
    )
  }
  const combined = signal ? AbortSignal.any([signal, idle.signal]) : idle.signal

  armIdleTimer()
  let reader: ReadableStreamDefaultReader<string> | undefined
  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [...history, userMessage], stream: true }),
      signal: combined,
    })
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '')
      throw new Error(`Ollama a répondu ${response.status}${detail ? ` : ${detail}` : ''}`)
    }

    reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
    let buffer = ''
    let assistantText = ''

    const handleLine = (line: string): Chunk[] => {
      if (!line.trim()) return []
      const chunk = JSON.parse(line) as OllamaLine
      if (chunk.error) throw new Error(`Ollama : ${chunk.error}`)
      const out: Chunk[] = []
      const content = chunk.message?.content ?? ''
      if (content) {
        assistantText += content
        out.push({ type: 'text', content })
      }
      if (chunk.done) {
        history.push(userMessage, { role: 'assistant', content: assistantText })
        out.push({
          type: 'done',
          duration_ms: (chunk.total_duration ?? 0) / 1e6,
          eval_count: chunk.eval_count ?? 0,
        })
      }
      return out
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      armIdleTimer()
      buffer += value
      // Une ligne NDJSON peut arriver coupée entre deux morceaux : on garde
      // le reste incomplet pour le tour suivant.
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        for (const chunk of handleLine(line)) {
          yield chunk
          if (chunk.type === 'done') return
        }
      }
    }
    for (const chunk of handleLine(buffer)) {
      yield chunk
      if (chunk.type === 'done') return
    }
    throw new Error('Flux Ollama interrompu avant la fin de la réponse')
  } catch (err) {
    // fetch/read rejettent avec la raison passée à abort() : on la remonte
    // telle quelle plutôt qu'une AbortError générique.
    if (combined.aborted && combined.reason instanceof Error) throw combined.reason
    throw err
  } finally {
    clearTimeout(timer)
    await reader?.cancel().catch(() => {})
  }
}
