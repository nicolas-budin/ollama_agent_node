import { defineConfig } from 'vitest/config'

// Sans ce fichier, vitest remonterait jusqu'à frontend/vite.config.js
// (environnement jsdom) : on isole les tests backend en environnement Node.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
