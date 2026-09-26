import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as ollamaClient from '../src/ollama-client.ts'
import type { Chunk } from '../src/ollama-client.ts'

// Construit une Response dont le body streame les morceaux de texte donnés
// (format NDJSON d'Ollama : un objet JSON par ligne).
function ndjsonResponse(pieces: string[], init: ResponseInit = {}): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const piece of pieces) controller.enqueue(encoder.encode(piece))
      controller.close()
    },
  })
  return new Response(body, init)
}

function lines(...objects: object[]): string[] {
  return objects.map((o) => JSON.stringify(o) + '\n')
}

async function collect(gen: AsyncGenerator<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

const DONE = { message: { content: '' }, done: true, total_duration: 123_000_000, eval_count: 42 }

describe('ollama-client', () => {
  beforeEach(() => ollamaClient.resetHistory())
  afterEach(() => vi.unstubAllGlobals())

  it('resetHistory remet uniquement le prompt système', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse(lines({ message: { content: 'Salut !' }, done: false }, DONE)),
    ))
    await collect(ollamaClient.streamChat('Bonjour'))
    expect(ollamaClient.getHistory()).toHaveLength(3)

    ollamaClient.resetHistory()

    expect(ollamaClient.getHistory()).toEqual([
      { role: 'system', content: ollamaClient.SYSTEM_PROMPT },
    ])
  })

  it('parse le NDJSON et met à jour l’historique', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      ndjsonResponse(
        lines(
          { message: { content: 'Bon' }, done: false },
          { message: { content: 'jour' }, done: false },
          DONE,
        ),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const chunks = await collect(ollamaClient.streamChat('Bonjour'))

    expect(chunks).toEqual([
      { type: 'text', content: 'Bon' },
      { type: 'text', content: 'jour' },
      { type: 'done', duration_ms: 123, eval_count: 42 },
    ])
    expect(ollamaClient.getHistory().slice(-2)).toEqual([
      { role: 'user', content: 'Bonjour' },
      { role: 'assistant', content: 'Bonjour' },
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(ollamaClient.OLLAMA_URL)
    const body = JSON.parse(init?.body as string)
    expect(body.model).toBe(ollamaClient.MODEL)
    expect(body.stream).toBe(true)
    expect(body.messages.at(-1)).toEqual({ role: 'user', content: 'Bonjour' })
  })

  it('ignore les lignes vides (keep-alive)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse([
        '\n',
        ...lines({ message: { content: 'Hi' }, done: false }),
        '\n',
        ...lines({ message: { content: '' }, done: true, total_duration: 0, eval_count: 1 }),
      ]),
    ))

    expect(await collect(ollamaClient.streamChat('Hi'))).toEqual([
      { type: 'text', content: 'Hi' },
      { type: 'done', duration_ms: 0, eval_count: 1 },
    ])
  })

  it('recolle une ligne JSON coupée entre deux morceaux', async () => {
    const full = lines({ message: { content: 'coupé' }, done: false }, DONE).join('')
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse([full.slice(0, 15), full.slice(15)])))

    const chunks = await collect(ollamaClient.streamChat('x'))

    expect(chunks[0]).toEqual({ type: 'text', content: 'coupé' })
    expect(chunks[1].type).toBe('done')
  })

  it('lève une erreur explicite sur un statut HTTP en échec', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response('{"error":"model not found"}', { status: 404 }),
    ))

    await expect(collect(ollamaClient.streamChat('x'))).rejects.toThrow(/404.*model not found/)
    expect(ollamaClient.getHistory()).toHaveLength(1)
  })

  it('ne pollue pas l’historique si le flux s’arrête avant "done"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      ndjsonResponse(lines({ message: { content: 'à moit' }, done: false })),
    ))

    await expect(collect(ollamaClient.streamChat('x'))).rejects.toThrow(/interrompu/)
    expect(ollamaClient.getHistory()).toEqual([
      { role: 'system', content: ollamaClient.SYSTEM_PROMPT },
    ])
  })

  it('remonte une erreur envoyée dans le flux par Ollama', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ndjsonResponse(lines({ error: 'out of memory' }))))

    await expect(collect(ollamaClient.streamChat('x'))).rejects.toThrow(/out of memory/)
  })

  it('abandonne après le délai d’inactivité', async () => {
    // Un fetch qui ne répond jamais, sauf à être annulé via son signal.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    ))

    await expect(
      collect(ollamaClient.streamChat('x', { idleTimeoutMs: 20 })),
    ).rejects.toThrow(/rien envoyé depuis 20 ms/)
    expect(ollamaClient.getHistory()).toHaveLength(1)
  })

  it('s’arrête quand le signal de l’appelant est annulé', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
      }),
    ))
    const aborter = new AbortController()
    const pending = collect(ollamaClient.streamChat('x', { signal: aborter.signal }))
    aborter.abort(new Error('Client déconnecté'))

    await expect(pending).rejects.toThrow('Client déconnecté')
    expect(ollamaClient.getHistory()).toHaveLength(1)
  })
})
