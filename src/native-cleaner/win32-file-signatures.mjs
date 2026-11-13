// These constants select a pre-existing regular leaf. Never DELETE_ON_CLOSE.
export const fileOpen = Object.freeze({
  desiredAccess: 0x80000000 + 0x00010000, // GENERIC_READ | DELETE
  shareMode: 0x00000001, // FILE_SHARE_READ only
  creationDisposition: 3, // OPEN_EXISTING
  flagsAndAttributes: 0x00200000, // FILE_FLAG_OPEN_REPARSE_POINT
});
