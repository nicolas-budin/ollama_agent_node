# ollama_agent_node

Démo de chat avec un modèle **Ollama local** (`gemma4:26b`), sans API cloud ni clé. Backend Node (Fastify, TypeScript exécuté nativement par Node 24), frontend React (Vite), réponse streamée en SSE.

Portage Node de [`ollama_agent`](../ollama_agent) (version Python/FastAPI) : même contrat HTTP, même frontend.

## Prérequis

- Node ≥ 24
- Ollama lancé avec le modèle téléchargé : `ollama list` doit afficher `gemma4:26b`

## Démarrer

```bash
npm install
npm run build:front   # build le frontend dans frontend/dist
npm start             # http://localhost:8124
```

### Développement (deux serveurs)

```bash
npm run dev                  # backend sur :8124, redémarre à chaque modification
npm --prefix frontend run dev  # frontend sur :5173, proxy /api → :8124
```

## Tests

```bash
npm test                     # backend (vitest, Ollama simulé)
npm run typecheck            # vérification TypeScript
npm --prefix frontend test   # frontend
```

## Docker

```bash
docker build -t ollama-agent-node .
docker run -p 8124:8124 ollama-agent-node
```

Le conteneur joint Ollama sur l'hôte via `host.docker.internal`. Sous Linux sans Docker Desktop, ajouter `--add-host=host.docker.internal:host-gateway`.

## Déploiement OpenShift (CRC)

Un pipeline Tekton (OpenShift Pipelines), lancé à la main, clone `main` depuis GitHub, lance les tests, construit l'image dans le registre interne et déploie dans le namespace `ollama-agent-node` :

```bash
git push origin main
oc create -f tekton/pipelinerun.yaml -n ollama-agent-node
```

Installation, suivi et rollback : voir [tekton/README.md](tekton/README.md).

## Variables d'environnement

| Variable | Défaut | Rôle |
|---|---|---|
| `OLLAMA_URL` | `http://localhost:11434/api/chat` | Endpoint chat d'Ollama |
| `OLLAMA_MODEL` | `gemma4:26b` | Modèle utilisé |
| `OLLAMA_IDLE_TIMEOUT_MS` | `120000` | Abandon si Ollama n'envoie rien pendant ce délai |
| `PORT` | `8124` | Port HTTP |
| `HOST` | `127.0.0.1` (`0.0.0.0` dans Docker) | Interface d'écoute |

## API

- `POST /api/chat` `{"message": "..."}` → flux SSE : événements `text` (morceaux de réponse), puis `done` (`{"duration_ms", "eval_count"}`) ou `error`.
- `POST /api/reset` → vide l'historique (bouton « Nouvelle conversation »).

L'historique est unique, partagé par tous les visiteurs et gardé en mémoire : une seule instance à la fois.
