/**
 * Mutex minimal, équivalent d'asyncio.Lock : chaque appel à run() attend que
 * le précédent soit terminé (succès ou échec) avant de démarrer.
 */
export class Lock {
  #tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn)
    // La file continue même si fn échoue : on n'enchaîne que sur la fin.
    this.#tail = result.catch(() => {})
    return result
  }
}
