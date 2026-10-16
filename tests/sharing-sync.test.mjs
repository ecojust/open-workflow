import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { createDocument } from '../src/core/documents.ts'
import { clone } from '../src/core/types.ts'
import { sharedContentKey } from '../src/core/sharing.ts'
import { createSharedHttpClient, SharedDocumentSync } from '../src/core/share-sync.ts'

const changed = (document, title) => ({ ...clone(document), title, updatedAt: new Date().toISOString() })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 30 && !predicate(); attempt++) await nextTurn()
  assert.ok(predicate(), 'Expected asynchronous operation to reach its checkpoint')
}
function server() {
  let snapshot = { sessionId: 'session-one', revision: 1, document: changed(createDocument('flow'), '初始文档') }
  const service = {
    reads: 0, writes: [],
    snapshot: () => clone(snapshot),
    replace: (document, sessionId = snapshot.sessionId) => { snapshot = { sessionId, revision: snapshot.revision + 1, document: clone(document) }; return clone(snapshot) },
    read: async () => { service.reads++; return clone(snapshot) },
    write: async request => {
      service.writes.push(clone(request))
      const accepted = request.sessionId === snapshot.sessionId && request.baseRevision === snapshot.revision
      if (accepted) snapshot = { ...snapshot, revision: snapshot.revision + 1, document: clone(request.document) }
      return { accepted, snapshot: clone(snapshot) }
    },
  }
  return service
}
function controller(t, service, options = {}) {
  const applied = [], states = []
  const sync = new SharedDocumentSync({ read: signal => service.read(signal), write: (request, signal) => service.write(request, signal), applyRemote: document => applied.push(clone(document)), onState: state => states.push(state), pollMs: 1_000_000, debounceMs: 1_000_000, ...options })
  sync.start(service.snapshot()); t.after(() => sync.stop())
  return { sync, applied, states }
}

test('local changes use the current revision and remote changes apply a fresh baseline', async t => {
  const service = server(), { sync, applied, states } = controller(t, service)
  sync.localChanged(changed(sync.localDocument, '本地编辑'))
  assert.equal(sync.state.status, 'pending'); assert.equal(sync.state.dirty, true)
  await sync.syncNow()
  assert.equal(service.writes[0].baseRevision, 1)
  assert.equal(sync.state.revision, 2); assert.equal(sync.state.status, 'synced'); assert.equal(applied.length, 0)
  service.replace(changed(service.snapshot().document, '另一设备编辑'))
  await sync.syncNow()
  assert.equal(applied.at(-1).title, '另一设备编辑'); assert.equal(sync.localDocument.title, '另一设备编辑')
  assert.equal(sync.state.dirty, false); assert.ok(states.some(state => state.status === 'syncing'))
})

test('two clients cannot silently overwrite concurrent edits and remote choice is explicit', async t => {
  const service = server(), first = controller(t, service), second = controller(t, service)
  first.sync.localChanged(changed(first.sync.localDocument, '设备甲'))
  second.sync.localChanged(changed(second.sync.localDocument, '设备乙'))
  await Promise.all([first.sync.syncNow(), second.sync.syncNow()])
  assert.equal(first.sync.state.status, 'synced'); assert.equal(second.sync.state.status, 'conflict')
  assert.equal(second.sync.localDocument.title, '设备乙'); assert.equal(second.applied.length, 0)
  assert.equal(second.sync.state.conflict.document.title, '设备甲')
  await second.sync.resolveConflict('remote')
  assert.equal(second.sync.localDocument.title, '设备甲'); assert.equal(second.applied.length, 1)
  assert.equal(second.sync.state.status, 'synced'); assert.equal(service.snapshot().document.title, '设备甲')
})

test('keeping local content compares against the reviewed conflict revision', async t => {
  const service = server(), { sync } = controller(t, service)
  sync.localChanged(changed(sync.localDocument, '我的版本'))
  service.replace(changed(service.snapshot().document, '已看到的远端版本'))
  await sync.syncNow()
  assert.equal(sync.state.conflict.revision, 2)
  service.replace(changed(service.snapshot().document, '尚未看到的新版本'))
  await sync.resolveConflict('local')
  assert.equal(service.writes.at(-1).baseRevision, 2)
  assert.equal(service.snapshot().document.title, '尚未看到的新版本')
  assert.equal(sync.state.status, 'conflict'); assert.equal(sync.state.conflict.revision, 3)
  assert.equal(sync.localDocument.title, '我的版本')
  await sync.resolveConflict('local')
  assert.equal(service.writes.at(-1).baseRevision, 3); assert.equal(service.snapshot().document.title, '我的版本')
  assert.equal(sync.state.status, 'synced')
})

test('an edit made while a remote read is in flight is preserved as a conflict', async t => {
  const service = server(), pending = deferred(), { sync, applied } = controller(t, service)
  const remote = service.replace(changed(service.snapshot().document, '远端新内容'))
  service.read = () => pending.promise
  const running = sync.syncNow()
  sync.localChanged(changed(sync.localDocument, '读取期间本地修改'))
  pending.resolve(remote); await running
  assert.equal(sync.state.status, 'conflict'); assert.equal(sync.localDocument.title, '读取期间本地修改')
  assert.equal(applied.length, 0); assert.equal(service.writes.length, 0)
})

test('remote content waits for a gesture and applies only once the editor is idle', async t => {
  const service = server(); let editing = true
  const { sync, applied } = controller(t, service, { canApplyRemote: () => !editing })
  service.replace(changed(service.snapshot().document, '远端移动图形'))
  await sync.syncNow(); await sync.syncNow()
  assert.equal(sync.state.status, 'waiting'); assert.equal(sync.state.remotePending, true); assert.equal(applied.length, 0)
  editing = false; await sync.syncNow()
  assert.equal(applied.length, 1); assert.equal(sync.state.status, 'synced')
})

test('committing a gesture while remote content waits preserves both versions', async t => {
  const service = server(); let editing = true
  const { sync, applied } = controller(t, service, { canApplyRemote: () => !editing })
  service.replace(changed(service.snapshot().document, '远端图形'))
  await sync.syncNow()
  editing = false; sync.localChanged(changed(sync.localDocument, '本地完成绘制'))
  assert.equal(sync.state.status, 'conflict'); assert.equal(applied.length, 0)
  assert.equal(sync.localDocument.title, '本地完成绘制'); assert.equal(sync.state.conflict.document.title, '远端图形')
})

test('remote conflict resolution refuses to interrupt pending editor input', async t => {
  const service = server(); let editing = false
  const { sync, applied } = controller(t, service, { canApplyRemote: () => !editing })
  sync.localChanged(changed(sync.localDocument, '本地'))
  service.replace(changed(service.snapshot().document, '远端')); await sync.syncNow()
  editing = true; await sync.resolveConflict('remote')
  assert.equal(sync.state.status, 'conflict'); assert.match(sync.state.error, /先完成/); assert.equal(applied.length, 0)
  editing = false; await sync.resolveConflict('remote')
  assert.equal(sync.state.status, 'synced'); assert.equal(applied.length, 1)
})

test('edits made during a write are not marked clean by the older write response', async t => {
  const service = server(), pending = deferred(), originalWrite = service.write
  let firstWrite = true, accepted
  service.write = async request => {
    const result = await originalWrite(request)
    if (firstWrite) { firstWrite = false; accepted = result; await pending.promise }
    return result
  }
  const { sync, applied } = controller(t, service)
  sync.localChanged(changed(sync.localDocument, '第一次编辑'))
  const running = sync.syncNow(); await until(() => Boolean(accepted))
  sync.localChanged(changed(sync.localDocument, '写入过程中继续编辑'))
  pending.resolve(); await running
  assert.equal(sync.localDocument.title, '写入过程中继续编辑'); assert.equal(sync.state.dirty, true)
  assert.equal(sync.state.revision, 2); assert.equal(applied.length, 0)
  await sync.syncNow()
  assert.equal(service.snapshot().document.title, '写入过程中继续编辑'); assert.equal(sync.state.status, 'synced')
})

test('a successful write with a lost response is acknowledged by matching remote content', async t => {
  const service = server(), originalWrite = service.write
  let loseResponse = true
  service.write = async request => {
    const result = await originalWrite(request)
    if (loseResponse) { loseResponse = false; throw new Error('响应中断') }
    return result
  }
  const { sync, applied } = controller(t, service)
  sync.localChanged(changed(sync.localDocument, '已由服务保存'))
  await sync.syncNow()
  assert.equal(sync.state.status, 'offline'); assert.equal(sync.state.dirty, true)
  await sync.syncNow()
  assert.equal(sync.state.status, 'synced'); assert.equal(sync.state.conflict, undefined)
  assert.equal(service.writes.length, 1); assert.equal(applied.length, 0)
})

test('offline retries retain edits and stopped controllers retain an exportable document', async t => {
  const service = server(), originalRead = service.read, { sync } = controller(t, service)
  sync.localChanged(changed(sync.localDocument, '离线内容'))
  service.read = async () => { throw new Error('网络不可用') }; await sync.syncNow()
  assert.equal(sync.state.status, 'offline'); assert.equal(sync.localDocument.title, '离线内容')
  service.read = originalRead; await sync.syncNow()
  assert.equal(sync.state.status, 'synced')
  sync.stop(); sync.localChanged(changed(sync.localDocument, '停止后的无效变更'))
  assert.equal(sync.localDocument.title, '离线内容'); assert.equal(sync.state.status, 'stopped')
})

test('late reads from a stopped controller cannot replace a newly started document', async t => {
  const service = server(), pending = deferred(); let signal
  const { sync, applied } = controller(t, service)
  service.read = nextSignal => { signal = nextSignal; return pending.promise }
  const oldSnapshot = service.snapshot(), running = sync.syncNow()
  sync.stop(); assert.equal(signal.aborted, true)
  const nextSnapshot = { sessionId: 'session-two', revision: 1, document: changed(createDocument('flow'), '新的文档') }
  sync.start(nextSnapshot); pending.resolve(oldSnapshot); await running
  assert.equal(sync.localDocument.id, nextSnapshot.document.id); assert.equal(sync.localDocument.title, '新的文档')
  assert.equal(sync.state.status, 'synced'); assert.equal(applied.length, 0)
})

test('late writes from a stopped controller cannot acknowledge another session', async t => {
  const service = server(), pending = deferred(); let request
  const { sync } = controller(t, service)
  service.write = body => { request = clone(body); return pending.promise }
  sync.localChanged(changed(sync.localDocument, '旧写入')); const running = sync.syncNow(); await until(() => Boolean(request))
  const nextSnapshot = { ...service.snapshot(), sessionId: 'session-two', document: changed(service.snapshot().document, '新会话') }
  sync.start(nextSnapshot)
  pending.resolve({ accepted: true, snapshot: { ...nextSnapshot, sessionId: 'session-one', revision: 2, document: request.document } }); await running
  assert.equal(sync.localDocument.title, '新会话'); assert.equal(sync.state.sessionId, 'session-two'); assert.equal(sync.state.revision, 1)
})

test('changed sessions and decreasing revisions are rejected without applying remote content', async t => {
  const service = server(), { sync, applied } = controller(t, service)
  const initial = service.snapshot()
  service.read = async () => ({ ...initial, sessionId: 'another-session', document: changed(initial.document, '越界内容') })
  await sync.syncNow(); assert.equal(sync.state.status, 'offline'); assert.match(sync.state.error, /会话已变更/)
  assert.equal(applied.length, 0); assert.equal(sync.localDocument.title, initial.document.title)
  sync.start({ ...initial, revision: 4 }); service.read = async () => initial
  await sync.syncNow(); assert.match(sync.state.error, /过期/); assert.equal(sync.state.revision, 4)
})

test('write responses from another session preserve the local version', async t => {
  const service = server(), { sync } = controller(t, service)
  service.write = async request => ({ accepted: true, snapshot: { sessionId: 'another-session', revision: 2, document: request.document } })
  sync.localChanged(changed(sync.localDocument, '本地留存')); await sync.syncNow()
  assert.equal(sync.state.status, 'offline'); assert.match(sync.state.error, /会话已变更/)
  assert.equal(sync.state.dirty, true); assert.equal(sync.state.revision, 1); assert.equal(sync.localDocument.title, '本地留存')
})

test('shared document identity is fixed and imported source data is never sent', async t => {
  const service = server(), { sync } = controller(t, service)
  const initial = sync.localDocument
  assert.throws(() => sync.localChanged({ ...initial, id: 'other-id' }), /标识/)
  assert.throws(() => sync.localChanged({ ...initial, kind: 'board' }), /类型/)
  sync.localChanged({ ...changed(initial, '安全副本'), importSource: { name: 'source.xml', format: 'graph', text: 'private-import-data' }, unknownField: 'private' })
  await sync.syncNow()
  assert.equal(service.writes[0].document.importSource, undefined); assert.equal(service.writes[0].document.unknownField, undefined)
  const copy = sync.localDocument; copy.title = '不应修改内部状态'
  assert.equal(sync.localDocument.title, '安全副本')
})

test('failed remote application rolls back the baseline and retries safely', async t => {
  const service = server(); let rejectApply = true
  const { sync } = controller(t, service, { applyRemote: () => { if (rejectApply) throw new Error('编辑器暂不可用') } })
  service.replace(changed(service.snapshot().document, '待接收内容')); await sync.syncNow()
  assert.equal(sync.state.status, 'offline'); assert.equal(sync.state.revision, 1); assert.equal(sync.localDocument.title, '初始文档')
  rejectApply = false; await sync.syncNow()
  assert.equal(sync.state.status, 'synced'); assert.equal(sync.localDocument.title, '待接收内容')
})

test('HTTP transport authenticates with a header and accepts a structured 409 conflict', async () => {
  const snapshot = server().snapshot(), requests = []
  const client = createSharedHttpClient('sample_token-123', { fetch: async (url, options) => {
    requests.push({ url, options })
    return new Response(JSON.stringify(options.method === 'GET' ? snapshot : { accepted: false, snapshot }), { status: options.method === 'GET' ? 200 : 409, headers: { 'Content-Type': 'application/json' } })
  } })
  assert.equal((await client.read()).revision, 1)
  const document = { ...snapshot.document, importSource: { name: 'a.xml', format: 'graph', text: 'private' } }
  const result = await client.write({ sessionId: snapshot.sessionId, baseRevision: 1, document })
  assert.equal(result.accepted, false)
  for (const request of requests) {
    assert.equal(request.url, '/api/document'); assert.equal(request.options.headers.Authorization, 'Bearer sample_token-123')
    assert.equal(request.options.credentials, 'omit'); assert.equal(request.options.cache, 'no-store'); assert.equal(request.options.redirect, 'error')
  }
  assert.equal(JSON.parse(requests[1].options.body).document.importSource, undefined)
  assert.equal(sharedContentKey(result.snapshot.document), sharedContentKey(snapshot.document))
})

test('HTTP transport rejects expired links, invalid bodies and malformed conflict responses', async () => {
  assert.throws(() => createSharedHttpClient('invalid/token'), /链接无效/)
  const expired = createSharedHttpClient('token', { fetch: async () => new Response('', { status: 401 }) })
  await assert.rejects(expired.read(), /链接已失效/)
  const malformed = createSharedHttpClient('token', { fetch: async () => new Response(JSON.stringify({ revision: 1 }), { status: 200 }) })
  await assert.rejects(malformed.read(), /版本无效/)
  const snapshot = server().snapshot(), wrongConflict = createSharedHttpClient('token', { fetch: async () => new Response(JSON.stringify({ accepted: true, snapshot }), { status: 409 }) })
  await assert.rejects(wrongConflict.write({ sessionId: snapshot.sessionId, baseRevision: 1, document: snapshot.document }), /无效的冲突响应/)
})

test('HTTP requests time out and forward external cancellation without leaking listeners', async () => {
  const fetch = async (_url, options) => new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true })
  })
  const client = createSharedHttpClient('token', { fetch, timeoutMs: 5 })
  await assert.rejects(client.read(), /连接超时/)
  const cancellation = new AbortController(), running = client.read(cancellation.signal)
  cancellation.abort(); await assert.rejects(running, error => error.name === 'AbortError')
})
