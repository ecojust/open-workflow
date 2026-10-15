export interface NativeFile { name: string; path: string; text: string; stamp: string }
export interface NativeSaveRequest { suggestedName: string; bytes: Uint8Array; path?: string; expectedStamp?: string }
export interface NativeSaveResult { name: string; path: string; stamp: string }

/** Importing this module is safe in a browser; native APIs load only when used. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function openNativeFiles(): Promise<NativeFile[]> {
  if (!isDesktop()) throw new Error('此操作需要桌面版。')
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<NativeFile[]>('open_native_files')
}

export async function saveNativeFile(request: NativeSaveRequest): Promise<NativeSaveResult | null> {
  if (!isDesktop()) throw new Error('此操作需要桌面版。')
  if (request.bytes.byteLength > 50 * 1024 * 1024) throw new Error('文件超过 50 MB 大小上限。')
  const parts: string[] = []
  for (let offset = 0; offset < request.bytes.length; offset += 32768) {
    parts.push(String.fromCharCode(...request.bytes.subarray(offset, offset + 32768)))
  }
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<NativeSaveResult | null>('save_native_file', {
    request: { suggestedName: request.suggestedName, bytesBase64: btoa(parts.join('')), path: request.path, expectedStamp: request.expectedStamp },
  })
}

export async function onNativeCloseRequest(handler: () => void): Promise<() => void> {
  if (!isDesktop()) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen('native-close-requested', handler)
}

export async function closeNativeWindow(): Promise<void> {
  if (!isDesktop()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('close_native_window')
}
