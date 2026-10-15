import test from 'node:test'
import assert from 'node:assert/strict'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { DIAGRAM_STYLES, normalizeDiagramStyle, applyDiagramStyle } from '../src/core/diagram-appearance.ts'
import { compileCodeDiagram } from '../src/core/code-diagram.ts'
import { DIAGRAM_TEMPLATES } from '../src/core/diagrams/catalog.ts'
import { createDocument, validateDocument, validateScene, parseDocument, serializeDocument, contentKey, DocumentHistory } from '../src/core/documents.ts'
import { documentScene, exportDocument } from '../src/core/files.ts'
import { importGraphXml } from '../src/formats/graph-xml.ts'
import { importBoardJson } from '../src/formats/board-json.ts'
import { sceneToSvg } from '../src/core/svg.ts'
import { DEFAULT_STYLE } from '../src/core/types.ts'

globalThis.DOMParser ??= DOMParser
globalThis.XMLSerializer ??= XMLSerializer
const withoutAppearance = scene => ({ ...scene, background: '', defaultStyle: scene.defaultStyle ? { ...scene.defaultStyle, fill: '', stroke: '', roughness: '' } : undefined, elements: scene.elements.map(element => ({ ...element, style: { ...element.style, fill: '', stroke: '', roughness: '' } })) })
const rgb = value => [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16) / 255)
const luminance = value => rgb(value).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0)
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05)
const deepFreeze = object => { if (object && typeof object === 'object') { Object.freeze(object); Object.values(object).forEach(deepFreeze) }; return object }
const fixture = kind => DIAGRAM_TEMPLATES.find(template => template.kind === kind).source

test('ten named presets are bounded, distinct and unknown style values safely normalize to classic', () => {
  assert.deepEqual(DIAGRAM_STYLES.map(style => style.id), ['classic', 'minimal', 'blueprint', 'ink', 'sketch', 'forest', 'ocean', 'sunset', 'lavender', 'midnight'])
  assert.equal(new Set(DIAGRAM_STYLES.map(style => JSON.stringify([style.background, style.palette, style.roughness]))).size, 10)
  for (const style of DIAGRAM_STYLES) {
    assert.equal(normalizeDiagramStyle(style.id), style.id)
    assert.ok(style.label && style.description && style.palette.length >= 8)
    assert.ok(contrast(style.foreground, style.background) >= 7)
  }
  for (const value of [undefined, null, false, 7, 'toString', '__proto__', 'MIDNIGHT', {}, { toString() { throw Error('must not coerce') } }]) assert.equal(normalizeDiagramStyle(value), 'classic')
})

test('classic is an independent exact clone and all styles preserve source geometry, data, text, arrows and dash semantics', () => {
  for (const template of DIAGRAM_TEMPLATES) {
    const scene = deepFreeze(compileCodeDiagram(template.source).scene)
    const classic = applyDiagramStyle(scene, 'classic')
    assert.deepEqual(classic, scene)
    assert.notEqual(classic, scene)
    assert.notEqual(classic.elements[0]?.style, scene.elements[0]?.style)
    for (const style of DIAGRAM_STYLES) {
      const result = applyDiagramStyle(scene, style.id)
      assert.deepEqual(withoutAppearance(result), withoutAppearance(scene), `${template.kind}/${style.id}`)
      assert.doesNotThrow(() => validateScene(result))
      assert.equal(new Set(result.elements.map(element => element.id)).size, result.elements.length)
      for (const node of result.elements.filter(element => element.type === 'shape' && element.shape === 'text')) if (style.id !== 'classic') assert.equal(node.style.fill, 'none')
    }
  }
})

test('pie sectors and legend swatches retain identical category colors without category collapse', () => {
  const source = 'pie showData\n"A": 1\n"B": 2\n"C": 3\n"D": 4\n"E": 5\n"F": 6\n"G": 7\n"H": 8'
  for (const style of DIAGRAM_STYLES) {
    const scene = applyDiagramStyle(compileCodeDiagram(source).scene, style.id)
    const sectors = scene.elements.filter(element => element.id.startsWith('pie-sector-'))
    assert.equal(new Set(sectors.map(element => element.style.fill)).size, 8)
    for (const sector of sectors) {
      const swatch = scene.elements.find(element => element.id === sector.id.replace('sector', 'key'))
      assert.equal(sector.style.fill, swatch.style.fill)
    }
  }
})

test('sankey flows and source nodes share their color, and styles retain quantitative opacity', () => {
  const original = compileCodeDiagram(fixture('sankey')).scene
  for (const style of DIAGRAM_STYLES) {
    const scene = applyDiagramStyle(original, style.id)
    for (let i = 0; i < original.elements.length; i++) {
      const element = original.elements[i]
      if (!element.id.startsWith('sankey-flow-')) continue
      const originalNode = original.elements.find(node => node.id.startsWith('sankey-node-') && node.style.fill === element.style.fill)
      assert.ok(originalNode)
      assert.equal(scene.elements[i].style.fill, scene.elements.find(node => node.id === originalNode.id).style.fill)
      assert.equal(scene.elements[i].style.opacity, element.style.opacity)
    }
  }
})

test('percentage overlays contrast against their actual sector, while outside legends contrast against the canvas', () => {
  const original = compileCodeDiagram('pie\n"A": 30\n"B": 20\n"C": 25\n"D": 25').scene
  for (const style of DIAGRAM_STYLES.filter(style => style.id !== 'classic')) {
    const scene = applyDiagramStyle(original, style.id)
    for (const label of scene.elements.filter(element => element.id.startsWith('pie-percent-'))) {
      const sector = scene.elements.find(element => element.id === label.id.replace('percent', 'sector'))
      assert.ok(contrast(label.style.stroke, sector.style.fill) >= 4.5, `${style.id}: ${label.id}`)
    }
    for (const label of scene.elements.filter(element => element.id.startsWith('pie-label-') || element.id === 'chart-title')) assert.ok(contrast(label.style.stroke, scene.background) >= 4.5, `${style.id}: ${label.id}`)
  }
})

test('text in filled C4 system cards remains readable in bright and dark presets', () => {
  const original = compileCodeDiagram(fixture('c4')).scene
  for (const style of DIAGRAM_STYLES.filter(style => style.id !== 'classic')) {
    const scene = applyDiagramStyle(original, style.id)
    for (const node of scene.elements.filter(element => element.type === 'shape' && element.shape !== 'text' && element.shape !== 'frame' && element.text)) assert.ok(contrast(node.style.stroke, node.style.fill) >= 4.5, `${style.id}/${node.id}`)
  }
})

test('same RGB colors written differently map consistently; transparent and zero-width paints remain intact', () => {
  const node = (id, fill, stroke = 'none') => ({ id, type: 'shape', shape: 'rectangle', x: 0, y: 0, width: 100, height: 50, text: '', locked: false, style: { ...DEFAULT_STYLE, fill, stroke, strokeWidth: 0, opacity: .4 } })
  const scene = { background: '#fff', grid: false, elements: [node('hex', '#f00'), node('name', 'red'), node('rgb', 'rgb(255,0,0)'), node('hsl', 'hsl(0,100%,50%)'), node('alpha', 'rgba(255,0,0,.5)'), node('transparent', 'transparent'), node('none', 'none')] }
  const result = applyDiagramStyle(scene, 'midnight')
  assert.equal(new Set(result.elements.slice(0, 4).map(element => element.style.fill)).size, 1)
  assert.equal(result.elements[4].style.fill, result.elements[0].style.fill + '80')
  assert.equal(result.elements[5].style.fill, 'transparent')
  assert.equal(result.elements[6].style.fill, 'none')
  assert.ok(result.elements.every(element => element.style.stroke === 'none' && element.style.strokeWidth === 0 && element.style.opacity === .4))
  assert.deepEqual(applyDiagramStyle({ ...scene, elements: [...scene.elements].reverse() }, 'midnight').elements.map(element => element.style.fill), [...result.elements].reverse().map(element => element.style.fill))
})

test('style is per-document, survives save and restore, participates in history, and never rewrites source', () => {
  const first = createDocument('mermaid'), second = createDocument('mermaid'), initialKey = contentKey(first), source = first.source
  const history = new DocumentHistory(first)
  assert.equal(JSON.parse(initialKey).length, 7, 'classic retains the released seven-field saved identity')
  first.diagramStyle = 'midnight'; history.commit(first)
  assert.notEqual(contentKey(first), initialKey)
  assert.equal(JSON.parse(contentKey(first)).length, 8)
  assert.equal(contentKey(second), contentKey({ ...second, diagramStyle: undefined }))
  const reopened = parseDocument(serializeDocument(first))
  assert.equal(reopened.diagramStyle, 'midnight')
  assert.equal(reopened.source, source)
  assert.equal(contentKey(reopened), contentKey(first))
  assert.equal(history.undo().diagramStyle, 'classic')
  assert.equal(history.redo().diagramStyle, 'midnight')
  assert.equal(second.diagramStyle, 'classic')
  for (const kind of ['flow', 'board', 'mermaid']) {
    const legacy = createDocument(kind); delete legacy.diagramStyle
    assert.equal(contentKey(validateDocument(legacy)), contentKey(legacy))
    assert.equal(validateDocument({ ...legacy, diagramStyle: 'untrusted-future-preset' }).diagramStyle, 'classic')
    assert.equal(contentKey({ ...legacy, diagramStyle: 'untrusted-future-preset' }), contentKey(legacy))
  }
})

test('compiled SVG and compatible exports share the selected style while source/original exports remain exact', async () => {
  const doc = createDocument('mermaid'); doc.source = 'flowchart LR\nA[Start] --> B[Finish]'; doc.diagramStyle = 'midnight'
  doc.importSource = { name: 'source.mmd', format: 'mermaid', text: doc.source }
  const snapshot = structuredClone(doc), scene = documentScene(doc)
  assert.equal(scene.background, DIAGRAM_STYLES.find(style => style.id === 'midnight').background)
  const decode = result => new TextDecoder().decode(result.bytes)
  assert.equal(decode(await exportDocument(doc, 'svg')), sceneToSvg(scene))
  const drawio = importGraphXml(decode(await exportDocument(doc, 'drawio')))[0].scene
  const excalidraw = importBoardJson(decode(await exportDocument(doc, 'excalidraw'))).scene
  for (const imported of [drawio, excalidraw]) {
    assert.equal(imported.background, scene.background)
    assert.deepEqual(imported.elements.filter(element => element.type === 'shape').map(element => element.style.fill), scene.elements.filter(element => element.type === 'shape').map(element => element.style.fill))
  }
  assert.equal(decode(await exportDocument(doc, 'mmd')), doc.source)
  assert.equal(decode(await exportDocument(doc, 'original')), doc.importSource.text)
  assert.deepEqual(doc, snapshot)
  const board = createDocument('board', true); board.diagramStyle = 'midnight'
  assert.deepEqual(documentScene(board), board.scene, 'editable canvases retain their authored appearances')
})

test('PNG rasterization receives the same styled SVG as direct SVG export', async () => {
  const originalDocument = globalThis.document, originalImage = globalThis.Image, originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL
  let captured, drawCount = 0
  globalThis.document = { createElement(name) { assert.equal(name, 'canvas'); return { width: 0, height: 0, getContext() { return { drawImage() { drawCount++ } } }, toBlob(callback, type) { assert.equal(type, 'image/png'); callback(new Blob(['png-output'], { type })) } } } }
  globalThis.Image = class { set src(value) { assert.equal(value, 'blob:test'); queueMicrotask(() => this.onload()) } }
  URL.createObjectURL = blob => { captured = blob; return 'blob:test' }
  URL.revokeObjectURL = value => assert.equal(value, 'blob:test')
  try {
    const doc = createDocument('mermaid'); doc.diagramStyle = 'blueprint'
    const result = await exportDocument(doc, 'png')
    assert.equal(result.mime, 'image/png'); assert.equal(drawCount, 1)
    assert.equal(await captured.text(), sceneToSvg(documentScene(doc)))
  } finally { globalThis.document = originalDocument; globalThis.Image = originalImage; URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke }
})
