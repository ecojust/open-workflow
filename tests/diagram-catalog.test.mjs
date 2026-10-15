import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser } from '@xmldom/xmldom'
import { DIAGRAM_TEMPLATES, DIAGRAM_KIND_LABELS } from '../src/core/diagrams/catalog.ts'
import { compileMermaid, MermaidSyntaxError } from '../src/core/mermaid.ts'
import { createDocument, serializeDocument, parseDocument, validateScene } from '../src/core/documents.ts'
import { sceneToSvg } from '../src/core/svg.ts'

test('the searchable catalog exposes a unique working template for every supported diagram kind', () => {
  assert.equal(Object.keys(DIAGRAM_KIND_LABELS).length, 22)
  assert.equal(new Set(DIAGRAM_TEMPLATES.map(template => template.id)).size, DIAGRAM_TEMPLATES.length)
  assert.deepEqual(new Set(DIAGRAM_TEMPLATES.map(template => template.kind)), new Set(Object.keys(DIAGRAM_KIND_LABELS)))
  for (const template of DIAGRAM_TEMPLATES) {
    assert.ok(template.title && template.description && template.category, template.id)
    const result = compileMermaid(template.source)
    assert.equal(result.kind, template.kind, template.id)
    assert.ok(result.scene.elements.length > 0, template.id)
    assert.deepEqual(compileMermaid(template.source), result, template.id)
    const doc = createDocument('mermaid')
    doc.source = template.source
    doc.scene = result.scene
    const reopened = parseDocument(serializeDocument(doc))
    assert.deepEqual(reopened.scene, validateScene(result.scene), template.id)
    assert.equal(reopened.source, template.source, template.id)
    const errors = []
    const xml = new DOMParser({ onError: (level, message) => errors.push({ level, message }) }).parseFromString(sceneToSvg(result.scene), 'image/svg+xml')
    assert.equal(xml.documentElement.nodeName, 'svg', template.id)
    assert.deepEqual(errors, [], template.id)
    assert.ok(!/NaN|Infinity/.test(sceneToSvg(result.scene)), template.id)
  }
})

test('every diagram parser preserves source line numbers and rejects executable configuration', () => {
  for (const template of DIAGRAM_TEMPLATES) {
    const source = `%% safe comment\n\n%%{init: {securityLevel: "loose"}}%%\n${template.source}`
    assert.throws(() => compileMermaid(source), error => error instanceof MermaidSyntaxError && error.line === 3, template.id)
    const prefixed = '\uFEFF%% safe comment\r\n\r\n' + template.source.replaceAll('\n', '\r\n')
    assert.equal(compileMermaid(prefixed).kind, template.kind, template.id)
  }
})
