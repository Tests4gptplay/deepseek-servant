/** Omit absent object fields before validating a native JSON storage record.
 * Arrays and non-JSON values retain their validation semantics.
 */
export function omitAbsentFields(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return value
  if (ancestors.has(value)) throw new TypeError('Storage records cannot contain circular references.')
  ancestors.add(value)
  try {
    if (Array.isArray(value)) return value.map(item => omitAbsentFields(item, ancestors))
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, omitAbsentFields(item, ancestors)]))
  } finally { ancestors.delete(value) }
}
