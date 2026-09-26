import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyServerOptions } from 'fastify'
import * as ollamaClient from './ollama-client.ts'

// Build React : `npm run build:front`
export const FRONTEND_DIST = fileURLToPath(new URL('../frontend/dist', import.meta.url))

type StreamChat = typeof ollamaClient.streamChat

export type AppOptions = {
  streamChat?: StreamChat
  logger?: FastifyServerOptions['logger']
}

/**
 * Formate un événement SSE. Comme sse-starlette, un `data` multiligne est
 * découpé en plusieurs lignes `data:` — que parseEvent() du frontend recolle
 * avec "\n". Sans ça, un saut de ligne dans la réponse du modèle couperait
 * l'événement en deux.
 */
export function sseEvent(event: string, data: string): string {
  const dataLines = data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join('\n')
  return `event: ${event}\n${dataLines}\n\n`
}

export function buildApp({ streamChat = ollamaClient.streamChat, logger = true }: AppOptions = {}) {
  const app = Fastify({ logger })

  app.post<{ Body: { message?: unknown } }>('/api/chat', async (request, reply) => {
    const raw = request.body?.message
    const message = typeof raw === 'string' ? raw.trim() : ''
    if (!message) {
      return reply.code(400).send({ error: 'message vide' })
    }

    // On prend la main sur la réponse brute pour streamer le SSE nous-mêmes.
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    // Si le navigateur ferme la connexion, on annule l'appel à Ollama pour
    // libérer le verrou au lieu de laisser la génération tourner dans le vide.
    const aborter = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) aborter.abort(new Error('Client déconnecté'))
    })

    request.log.info('Message reçu : %s', message)
    await ollamaClient.lock.run(async () => {
      try {
        for await (const chunk of streamChat(message, { signal: aborter.signal })) {
          if (chunk.type === 'text') {
            reply.raw.write(sseEvent('text', chunk.content))
          } else {
            request.log.info(
              'Durée : %d ms | Tokens générés : %d',
              Math.round(chunk.duration_ms),
              chunk.eval_count,
            )
            reply.raw.write(
              sseEvent(
                'done',
                JSON.stringify({ duration_ms: chunk.duration_ms, eval_count: chunk.eval_count }),
              ),
            )
          }
        }
      } catch (err) {
        if (aborter.signal.aborted) {
          request.log.info('Génération annulée : client déconnecté')
        } else {
          request.log.error(err, 'Erreur pendant la génération')
          reply.raw.write(sseEvent('error', err instanceof Error ? err.message : String(err)))
        }
      }
    })
    reply.raw.end()
  })

  app.post('/api/reset', async (request) => {
    await ollamaClient.lock.run(async () => ollamaClient.resetHistory())
    request.log.info('Historique réinitialisé')
    return { status: 'ok' }
  })

  // Enregistré en dernier, et seulement si le build existe : frontend/dist est
  // absent tant que `npm run build:front` n'a pas tourné (gitignored), et les
  // tests backend n'en ont pas besoin.
  if (existsSync(FRONTEND_DIST)) {
    app.register(fastifyStatic, { root: FRONTEND_DIST, prefix: '/' })
  } else {
    app.log.warn('%s introuvable : lancer `npm run build:front` pour servir le frontend', FRONTEND_DIST)
  }

  return app
}
