import { useCallback, useEffect, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { DirectoryBrowser, type DirectoryBrowserProps } from '@deepseek-ai/dsh-client-ui-directory-picker-browse/src/client/DirectoryBrowser.tsx'

import { DIRECTORY_NS } from './directory-locales.js'

type Listing = Awaited<ReturnType<DirectoryBrowserProps['listDirectory']>>
type WorkspacePicker = Pick<DirectoryBrowserProps, 'listDirectory' | 'createDirectory'> & { pickDirectory(): Promise<string | null> }
export function useDirectoryPicker(ctx: Context, browse?: Pick<DirectoryBrowserProps, 'listDirectory' | 'createDirectory'>) {
  const [listing, setListing] = useState<Listing>()
  const finish = useRef<((value: string | null) => void)>()
  const firstListing = useRef<Listing>()
  const active = useRef(true)
  const opening = useRef(false)
  useEffect(() => { active.current = true; return () => { active.current = false; finish.current?.(null); finish.current = undefined } }, [])
  const complete = (value: string | null) => { const done = finish.current; finish.current = undefined; firstListing.current = undefined; setListing(undefined); done?.(value) }
  const workspace = ctx.get('uiWorkspace') as unknown as WorkspacePicker | undefined
  const browser = browse ?? workspace
  const desktop = (globalThis as typeof globalThis & { __DSH_DIRECTORY_PICKER__?: { pick(): Promise<string | null> } }).__DSH_DIRECTORY_PICKER__
  // DirectoryBrowser's open effect follows listDirectory identity. Keep the
  // adapter stable across Cordis traceable proxies. Resolve the current service
  // for each scan rather than retaining a possibly retired implementation.
  const listDirectory = useCallback<DirectoryBrowserProps['listDirectory']>(async (path, signal) => {
    if (path === undefined && firstListing.current) {
      const cached = firstListing.current
      firstListing.current = undefined
      return cached
    }
    const current = browse ?? ctx.get('uiWorkspace') as unknown as WorkspacePicker | undefined
    if (!current) throw new Error('Directory picker is unavailable.')
    return current.listDirectory(path, signal)
  }, [ctx, browse])
  const pick = async (initialPath?: string): Promise<string | null> => {
    if (opening.current || finish.current) throw new Error('A directory picker is already open.')
    if (desktop && (!initialPath?.trim() || !browser)) {
      opening.current = true
      try { return await desktop.pick() } finally { opening.current = false }
    }
    if (!browser) throw new Error('Directory picker is unavailable.')
    opening.current = true
    let initial: Listing
    try { initial = await browser.listDirectory(initialPath?.trim() || undefined) }
    catch (error) {
      if (workspace && !browse && (error as { rpcError?: { code?: string } })?.rpcError?.code === 'directory-picker/unavailable') return await workspace.pickDirectory()
      throw error
    } finally { opening.current = false }
    if (!active.current) return null
    firstListing.current = initial
    return new Promise(resolve => { finish.current = resolve; setListing(initial) })
  }
  return {
    pick: desktop || browser ? pick : undefined,
    dialog: listing && browser ? <DirectoryBrowser open busy={false}
      listDirectory={listDirectory}
      createDirectory={(path, name) => browser.createDirectory(path, name)}
      onOpen={complete} onClose={() => complete(null)} t={ctx.locale.bind(DIRECTORY_NS)} /> : null,
  }
}
