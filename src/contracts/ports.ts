/** Awaited single-record storage. No cross-record transaction or CAS is assumed. */
export interface StoragePort {
  get<T>(key: string): Promise<T | undefined>
  set<T>(key: string, value: T): Promise<void>
  list<T>(prefix: string): Promise<Array<{ key: string; value: T }>>
  delete?(key: string): Promise<void>
  /** Actual files in the owned record tree, including serialized wrappers. */
  usageFiles?(): Promise<Array<{ key?: string; path: string; bytes: number }>>
  /** Exact d19 Local Host control row, read only from its retained native JSON folder. */
  readLegacyLocalControls?(scope: string): Promise<unknown | undefined>
}

export interface Clock { now(): string }

