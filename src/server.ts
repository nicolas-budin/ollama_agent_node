import { buildApp } from './app.ts'

const port = Number(process.env.PORT ?? 8124)
// 127.0.0.1 en local ; le Dockerfile passe HOST=0.0.0.0.
const host = process.env.HOST ?? '127.0.0.1'

const app = buildApp()

// Ferme proprement le serveur (et les streams en cours) sur Ctrl+C / docker stop.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    app.close().then(() => process.exit(0))
  })
}

try {
  await app.listen({ port, host })
} catch (err) {
  app.log.error(err)
  process.exit(1)
}
