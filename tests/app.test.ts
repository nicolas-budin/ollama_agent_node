import { beforeEach, describe, expect, it } from 'vitest'
import { buildApp, sseEvent } from '../src/app.ts'
import * as ollamaClient from '../src/ollama-client.ts'
import type { Chunk, StreamChatOptions } from '../src/ollama-client.ts'

function fakeStreamChat(chunks: Chunk[], received: string[] = []) {
  return async function* (message: string, _opts?: StreamChatOptions) {
    received.push(message)
    yield* chunks
  }
}

describe('app', () => {
  beforeEach(() => ollamaClient.resetHistory())

  it('renvoie 400 sur un message vide', async () => {
    const app = buildApp({ logger: false, streamChat: fakeStreamChat([]) })
    const resp = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '   ' } })
    expect(resp.statusCode).toBe(400)
    expect(resp.json()).toEqual({ error: 'message vide' })
  })

  it('streame les événements text et done', async () => {
    const app = buildApp({
      logger: false,
      streamChat: fakeStreamChat([
        { type: 'text', content: 'Bon' },
        { type: 'text', content: 'jour' },
        { type: 'done', duration_ms: 123, eval_count: 42 },
      ]),
    })

    const resp = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'Bonjour' } })

    expect(resp.statusCode).toBe(200)
    expect(resp.headers['content-type']).toMatch(/text\/event-stream/)
    expect(resp.body).toBe(
      'event: text\ndata: Bon\n\n' +
        'event: text\ndata: jour\n\n' +
        'event: done\ndata: {"duration_ms":123,"eval_count":42}\n\n',
    )
  })

  it('transmet le message nettoyé à streamChat', async () => {
    const received: string[] = []
    const app = buildApp({ logger: false, streamChat: fakeStreamChat([], received) })

    await app.inject({ method: 'POST', url: '/api/chat', payload: { message: '  Quelle heure est-il ?  ' } })

    expect(received).toEqual(['Quelle heure est-il ?'])
  })

  it('découpe un texte multiligne en plusieurs lignes data:', async () => {
    const app = buildApp({
      logger: false,
      streamChat: fakeStreamChat([{ type: 'text', content: 'ligne 1\nligne 2' }]),
    })

    const resp = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'x' } })

    expect(resp.body).toBe('event: text\ndata: ligne 1\ndata: ligne 2\n\n')
  })

  it('envoie un événement error si la génération échoue', async () => {
    const app = buildApp({
      logger: false,
      streamChat: async function* () {
        yield* []
        throw new Error('boom')
      },
    })

    const resp = await app.inject({ method: 'POST', url: '/api/chat', payload: { message: 'test' } })

    expect(resp.body).toBe('event: error\ndata: boom\n\n')
  })

  it('reset vide l’historique', async () => {
    const app = buildApp({
      logger: false,
      streamChat: fakeStreamChat([]),
    })

    const resp = await app.inject({ method: 'POST', url: '/api/reset' })

    expect(resp.statusCode).toBe(200)
    expect(resp.json()).toEqual({ status: 'ok' })
    expect(ollamaClient.getHistory()).toEqual([
      { role: 'system', content: ollamaClient.SYSTEM_PROMPT },
    ])
  })
})

describe('sseEvent', () => {
  it('gère les lignes vides et les \\r\\n', () => {
    expect(sseEvent('text', 'a\r\n\nb')).toBe('event: text\ndata: a\ndata: \ndata: b\n\n')
  })
})
