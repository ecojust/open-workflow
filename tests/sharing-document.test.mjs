import test from 'node:test'
import assert from 'node:assert/strict'
import { createDocument } from '../src/core/documents.ts'
import { newId } from '../src/core/types.ts'
import { sharedDocument, sharedContentKey, validateSharedSnapshot } from '../src/core/sharing.ts'

test('shared documents omit file locations and preserved import data without changing the original', () => {
  const original = createDocument('flow', true)
  original.importSource = { name: 'original.xml', format: 'xml', text: '<private-original/>' }
  const before = structuredClone(original)
  const shared = sharedDocument({ ...original, path: '/private/original.xml', stamp: 'private-stamp', otherTabs: ['private'] })
  assert.deepEqual(original, before)
  for (const key of ['importSource', 'path', 'stamp', 'otherTabs']) assert.equal(key in shared, false)
  assert.deepEqual(shared.scene, original.scene)
  assert.equal(sharedContentKey(original), sharedContentKey(shared))
  const edited = structuredClone(shared); edited.scene.elements[0].text = '来自网页的修改'
  assert.notEqual(sharedContentKey(original), sharedContentKey(edited))
})

test('shared snapshots require a usable session and monotonically comparable revision', () => {
  const document = createDocument('mermaid')
  document.source = '尚未输入完成的源码'
  assert.equal(validateSharedSnapshot({ sessionId: 'session', revision: 1, document }).document.source, document.source)
  for (const revision of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1']) {
    assert.throws(() => validateSharedSnapshot({ sessionId: 'session', revision, document }))
  }
  assert.throws(() => validateSharedSnapshot({ sessionId: '', revision: 1, document }))
  assert.throws(() => validateSharedSnapshot({ sessionId: 'session', revision: 1, document: {} }))
})

test('element identifiers work on local HTTP pages without the secure-context UUID helper', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID')
  Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })
  try {
    const ids = Array.from({ length: 100 }, () => newId('local'))
    assert.equal(new Set(ids).size, ids.length)
    for (const id of ids) assert.match(id, /^local-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor)
    else delete crypto.randomUUID
  }
})
