# --- Étape 1 : build du frontend React/Vite ---
FROM node:24-slim AS frontend-build
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# --- Étape 2 : backend Fastify + frontend buildé ---
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

# Ollama tourne sur la machine hôte, pas dans ce conteneur : surcharger
# OLLAMA_URL au run si "host.docker.internal" ne résout pas (Linux sans
# Docker Desktop nécessite --add-host=host.docker.internal:host-gateway).
ENV OLLAMA_URL=http://host.docker.internal:11434/api/chat
ENV HOST=0.0.0.0

USER node
EXPOSE 8124
CMD ["node", "src/server.ts"]
