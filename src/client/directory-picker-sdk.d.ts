import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { DirectoryEntry as PickerDirectoryEntry, DirectoryListing as PickerDirectoryListing } from '@deepseek-ai/dsh-host-directory-picker'

// The published browse component imports these types from the remote facade,
// which does not re-export them. Use the exact types from the picker service.
declare module '@deepseek-ai/dsh-api-remotes/client' {
  export type DirectoryEntry = PickerDirectoryEntry
  export type DirectoryListing = PickerDirectoryListing
}
