import type { WorkflowDocument } from './types.ts'
import { clone } from './types.ts'
import { sharedContentKey, sharedDocument, validateSharedSnapshot, type SharedSnapshot, type SharedWriteRequest, type SharedWriteResult } from './sharing.ts'

export type SharedSyncPhase = 'synced' | 'pending' | 'syncing' | 'waiting' | 'offline' | 'conflict' | 'stopped'
export interface SharedSyncState {
  status: SharedSyncPhase
  dirty: boolean
  remotePending: boolean
  revision: number
  sessionId: string
  error?: string
  conflict?: SharedSnapshot
}
export interface SharedDocumentSyncOptions {
  read: (signal?: AbortSignal) => Promise<SharedSnapshot>
  write: (request: SharedWriteRequest, signal?: AbortSignal) => Promise<SharedWriteResult>
  applyRemote: (document: WorkflowDocument, snapshot: SharedSnapshot) => void
  canApplyRemote?: () => boolean
  onState?: (state: SharedSyncState) => void
  pollMs?: number
  debounceMs?: number
}

/** Whole-document compare-and-swap keeps concurrent edits explicit and recoverable. */
export class SharedDocumentSync {
  private readonly options: SharedDocumentSyncOptions
  private baseline?: SharedSnapshot
  private local?: WorkflowDocument
  private localKey = ''
  private baselineKey = ''
  private pendingRemote?: SharedSnapshot
  private conflictRemote?: SharedSnapshot
  private error?: string
  private phase: SharedSyncPhase = 'stopped'
  private generation = 0
  private stopped = true
  private inFlight?: Promise<void>
  private request?: AbortController
  private pollTimer?: ReturnType<typeof setTimeout>
  private editTimer?: ReturnType<typeof setTimeout>
  private rerun = false
  private notification = ''
  private localResolution?: { snapshot: SharedSnapshot; document: WorkflowDocument }

  constructor(options: SharedDocumentSyncOptions) { this.options = options }
  get localDocument(): WorkflowDocument | undefined { return this.local ? clone(this.local) : undefined }
  get state(): SharedSyncState {
    return { status: this.phase, dirty: !!this.baseline && this.localKey !== this.baselineKey, remotePending: !!this.pendingRemote, revision: this.baseline?.revision ?? 0, sessionId: this.baseline?.sessionId ?? '', ...(this.error ? { error: this.error } : {}), ...(this.conflictRemote ? { conflict: clone(this.conflictRemote) } : {}) }
  }
  start(snapshot: SharedSnapshot): void {
    this.stop()
    const checked = validateSharedSnapshot(snapshot)
    this.baseline = clone(checked); this.local = clone(checked.document)
    this.localKey = this.baselineKey = sharedContentKey(checked.document)
    this.pendingRemote = undefined; this.conflictRemote = undefined; this.localResolution = undefined; this.error = undefined
    this.stopped = false; this.phase = 'synced'; this.notification = ''; this.publish(); this.schedulePoll()
  }
  localChanged(document: WorkflowDocument): void {
    if (this.stopped || !this.baseline) return
    const checked = sharedDocument(document)
    this.assertIdentity(checked)
    const key = sharedContentKey(checked)
    if (key === this.localKey) return
    this.local = checked; this.localKey = key
    this.error = undefined
    if (this.pendingRemote) this.observe(this.pendingRemote)
    if (this.conflictRemote && this.localKey === sharedContentKey(this.conflictRemote.document)) this.acknowledge(this.conflictRemote)
    this.publish()
    if (!this.conflictRemote) {
      clearTimeout(this.editTimer)
      this.editTimer = setTimeout(() => { this.editTimer = undefined; void this.syncNow() }, Math.max(0, this.options.debounceMs ?? 400))
    }
  }
  syncNow(): Promise<void> {
    if (this.stopped || !this.baseline) return Promise.resolve()
    clearTimeout(this.pollTimer); this.pollTimer = undefined
    clearTimeout(this.editTimer); this.editTimer = undefined
    if (this.inFlight) { this.rerun = true; return this.inFlight }
    const generation = this.generation
    const request = new AbortController(); this.request = request
    const run = this.run(generation, request.signal).catch(error => {
      if (this.stopped || generation !== this.generation) return
      this.error = error instanceof Error ? error.message : '连接失败，本地修改已保留。'
      this.phase = this.conflictRemote ? 'conflict' : 'offline'; this.publish(true)
    }).finally(() => {
      if (generation !== this.generation) return
      this.inFlight = undefined; this.request = undefined
      if (this.stopped) return
      if (this.rerun) { this.rerun = false; this.pollTimer = setTimeout(() => { this.pollTimer = undefined; void this.syncNow() }, 0) }
      else this.schedulePoll()
    })
    this.inFlight = run
    return run
  }
  async resolveConflict(choice: 'remote' | 'local'): Promise<void> {
    if (this.stopped || !this.conflictRemote || !this.local) return
    if (choice === 'remote') {
      if (!this.canApply()) { this.error = '请先完成当前绘制或文字编辑，再采用远端版本。'; this.publish(); return }
      const remote = this.conflictRemote
      this.apply(remote); this.error = undefined; this.publish(); return
    }
    // The user approves this reviewed revision only. A newer remote write must conflict again.
    this.localResolution = { snapshot: clone(this.conflictRemote), document: clone(this.local) }
    this.error = undefined
    if (this.inFlight) await this.inFlight
    if (!this.stopped && this.localResolution) await this.syncNow()
  }
  stop(): void {
    this.stopped = true; this.generation++; this.request?.abort(); this.request = undefined
    clearTimeout(this.pollTimer); clearTimeout(this.editTimer); this.pollTimer = undefined; this.editTimer = undefined
    this.inFlight = undefined; this.rerun = false; this.localResolution = undefined; this.phase = 'stopped'; this.publish(true)
  }
  private canApply(): boolean { return this.options.canApplyRemote?.() !== false }
  private assertIdentity(document: WorkflowDocument): void {
    if (this.baseline && (document.id !== this.baseline.document.id || document.kind !== this.baseline.document.kind)) throw new Error('共享连接仅允许修改当前文档，不能切换文档类型或标识。')
  }
  private isCurrent(generation: number): boolean { return !this.stopped && this.generation === generation }
  private check(snapshot: SharedSnapshot): SharedSnapshot {
    const checked = validateSharedSnapshot(snapshot); this.assertIdentity(checked.document)
    if (this.baseline && checked.sessionId !== this.baseline.sessionId) throw new Error('共享会话已变更，请使用桌面端提供的新链接；当前修改仍保留在此页面。')
    if (this.baseline && checked.sessionId === this.baseline.sessionId && checked.revision < this.baseline.revision) throw new Error('收到过期的共享版本，请重试连接。')
    return checked
  }
  private acknowledge(snapshot: SharedSnapshot): void {
    this.baseline = clone(snapshot); this.baselineKey = sharedContentKey(snapshot.document)
    this.pendingRemote = undefined; this.conflictRemote = undefined; this.error = undefined
  }
  private apply(snapshot: SharedSnapshot): void {
    const previous = { baseline: this.baseline, local: this.local, localKey: this.localKey, baselineKey: this.baselineKey, pending: this.pendingRemote, conflict: this.conflictRemote }
    this.local = clone(snapshot.document); this.localKey = sharedContentKey(snapshot.document); this.acknowledge(snapshot)
    try { this.options.applyRemote(clone(snapshot.document), clone(snapshot)) }
    catch (error) {
      this.baseline = previous.baseline; this.local = previous.local; this.localKey = previous.localKey; this.baselineKey = previous.baselineKey; this.pendingRemote = previous.pending; this.conflictRemote = previous.conflict
      throw error
    }
  }
  private observe(snapshot: SharedSnapshot): void {
    const remoteKey = sharedContentKey(snapshot.document)
    if (remoteKey === this.localKey) { this.acknowledge(snapshot); return }
    const changed = snapshot.sessionId !== this.baseline!.sessionId || snapshot.revision !== this.baseline!.revision || remoteKey !== this.baselineKey
    if (!changed) { this.pendingRemote = undefined; return }
    if (this.localKey !== this.baselineKey) {
      this.conflictRemote = clone(snapshot); this.pendingRemote = undefined; return
    }
    if (!this.canApply()) { this.pendingRemote = clone(snapshot); return }
    this.apply(snapshot)
  }
  private async run(generation: number, signal: AbortSignal): Promise<void> {
    this.phase = this.conflictRemote && !this.localResolution ? 'conflict' : 'syncing'; this.publish(true)
    const resolution = this.localResolution; this.localResolution = undefined
    if (resolution) {
      await this.write(resolution.snapshot, resolution.document, generation, signal)
      return
    }
    const remote = this.check(await this.options.read(signal))
    if (!this.isCurrent(generation)) return
    this.error = undefined
    if (this.conflictRemote) {
      if (sharedContentKey(remote.document) === this.localKey) this.acknowledge(remote)
      else this.conflictRemote = clone(remote)
    } else this.observe(remote)
    if (this.conflictRemote || this.pendingRemote || this.localKey === this.baselineKey) { this.publish(); return }
    await this.write(this.baseline!, this.local!, generation, signal)
  }
  private async write(baseline: SharedSnapshot, document: WorkflowDocument, generation: number, signal: AbortSignal): Promise<void> {
    const sent = sharedDocument(document), sentKey = sharedContentKey(sent)
    const result = await this.options.write({ sessionId: baseline.sessionId, baseRevision: baseline.revision, document: sent }, signal)
    if (!this.isCurrent(generation)) return
    if (!result || typeof result.accepted !== 'boolean') throw new Error('共享服务返回了无效的保存响应。')
    const snapshot = this.check(result.snapshot)
    this.error = undefined
    if (result.accepted && sharedContentKey(snapshot.document) === sentKey) {
      this.acknowledge(snapshot)
      if (this.localKey !== this.baselineKey) this.rerun = true
    } else if (sharedContentKey(snapshot.document) === this.localKey) this.acknowledge(snapshot)
    else { this.conflictRemote = clone(snapshot); this.pendingRemote = undefined }
    this.publish()
  }
  private publish(keepPhase = false): void {
    if (!keepPhase && !this.stopped) {
      this.phase = this.conflictRemote ? 'conflict' : this.pendingRemote ? 'waiting' : this.localKey !== this.baselineKey ? 'pending' : 'synced'
    }
    const notification = [this.phase, this.localKey !== this.baselineKey, !!this.pendingRemote, this.baseline?.sessionId, this.baseline?.revision, this.conflictRemote?.sessionId, this.conflictRemote?.revision, this.error].join('|')
    if (notification === this.notification) return
    this.notification = notification; this.options.onState?.(this.state)
  }
  private schedulePoll(): void {
    if (this.stopped) return
    clearTimeout(this.pollTimer)
    this.pollTimer = setTimeout(() => { this.pollTimer = undefined; void this.syncNow() }, Math.max(100, this.options.pollMs ?? 1200))
  }
}

export interface SharedHttpClient {
  read: (signal?: AbortSignal) => Promise<SharedSnapshot>
  write: (request: SharedWriteRequest, signal?: AbortSignal) => Promise<SharedWriteResult>
}
export function createSharedHttpClient(token: string, options: { fetch?: typeof fetch; timeoutMs?: number; endpoint?: string } = {}): SharedHttpClient {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('共享链接无效。')
  const transport = options.fetch ?? globalThis.fetch.bind(globalThis), endpoint = options.endpoint ?? '/api/document'
  async function request(method: 'GET' | 'PUT', body?: SharedWriteRequest, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController(), abort = () => controller.abort()
    if (signal?.aborted) controller.abort(); else signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
    try {
      const response = await transport(endpoint, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify({ ...body, document: sharedDocument(body.document) }) : undefined, signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error' })
      if (!response.ok && !(method === 'PUT' && response.status === 409)) {
        if (response.status === 401 || response.status === 403) throw new Error('共享链接已失效，请从桌面端重新获取链接。')
        if (response.status === 404 || response.status === 410) throw new Error('共享服务已停止，当前修改仍保留在此页面。')
        if (response.status === 413) throw new Error('共享文档过大，请减少图片或导出本地备份。')
        throw new Error(`共享服务暂时不可用（${response.status}），本地修改已保留。`)
      }
      const data: unknown = await response.json()
      if (method === 'PUT' && response.status === 409 && (data as { accepted?: unknown } | null)?.accepted !== false) throw new Error('共享服务返回了无效的冲突响应。')
      return data
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error('连接超时，本地修改已保留，可稍后重试。')
      throw error
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort) }
  }
  return {
    read: async signal => validateSharedSnapshot(await request('GET', undefined, signal)),
    write: async (body, signal) => {
      const data = await request('PUT', body, signal)
      if (!data || typeof data !== 'object' || typeof (data as SharedWriteResult).accepted !== 'boolean') throw new Error('共享服务返回了无效的保存响应。')
      return { accepted: (data as SharedWriteResult).accepted, snapshot: validateSharedSnapshot((data as SharedWriteResult).snapshot) }
    },
  }
}
