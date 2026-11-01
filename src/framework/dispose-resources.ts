/** Dispose owned resources in dependency order. One failure must not skip later
 * releases; retaining all original errors keeps incomplete cleanup observable. */
export async function disposeResources(steps: readonly (() => void | Promise<void>)[]): Promise<void> {
  const errors: unknown[] = []
  for (const step of steps) {
    try { await step() } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, 'DSS resource disposal failed.')
}
