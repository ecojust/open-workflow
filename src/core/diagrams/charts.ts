import type { ElementStyle, Point, SceneElement } from '../types.ts'
import {
  diagramEdge, diagramNode, diagramStroke, diagramText, finishDiagram,
  DiagramSyntaxError, sourceLines,
  type DiagramResult, type DiagramTemplate,
} from './common.ts'

type Line = { text: string; line: number }
const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?'
const COLORS = ['#6389e7', '#61b9a0', '#f0b45b', '#ad86d6', '#e78291', '#5bafca', '#bdba5a', '#bc8e70']
const DAY = 86_400_000
const fail = (message: string, at: Line): never => { throw new DiagramSyntaxError(message, at.line) }
const style = (fill: string, stroke = '#ffffff'): Partial<ElementStyle> => ({ fill, stroke, strokeWidth: 1.5 })

function text(value: string, at: Line): string {
  let result = value.trim()
  if (result.startsWith('"')) {
    try { result = JSON.parse(result) } catch { return fail('文字引号不完整；请使用有效的双引号文本。', at) }
  }
  if (typeof result !== 'string' || !result.trim() || result.length > 2000) return fail('文字不能为空，且不能超过 2,000 个字符。', at)
  return result.replace(/<br\s*\/?\s*>/gi, '\n')
}
function number(value: string, at: Line, limit = 1e12): number {
  if (!new RegExp(`^${NUMBER}$`).test(value.trim())) return fail(`“${value}”不是有效数值。`, at)
  const result = Number(value)
  if (!Number.isFinite(result) || Math.abs(result) > limit) return fail(`数值必须有限，绝对值不能超过 ${limit}。`, at)
  return result
}
function labelNumber(value: number): string {
  return Math.abs(value) >= 1e7 || (value !== 0 && Math.abs(value) < .001) ? value.toExponential(2) : Number(value.toPrecision(6)).toString()
}
function commaList(value: string, at: Line): string[] {
  const result: string[] = []
  let begin = 0, quoted = false, escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') quoted = !quoted
    if (!quoted && char === ',') { result.push(value.slice(begin, i).trim()); begin = i + 1 }
  }
  if (quoted) return fail('列表中的双引号未闭合。', at)
  result.push(value.slice(begin).trim())
  if (result.some(item => !item)) return fail('列表不能为空或包含空项。', at)
  return result
}
function titleNode(title: string): SceneElement { return diagramText('chart-title', title, 80, 25, 900, 54, { fontSize: 27, textAlign: 'left', stroke: '#24334d' }) }
function stroke(id: string, points: Point[], options: Partial<ElementStyle> = {}): SceneElement {
  return diagramStroke(id, points, { stroke: '#b5c1d1', strokeWidth: 1, fill: 'none', ...options })
}

function pie(lines: Line[]): DiagramResult {
  const header = lines[0]!
  const declaration = /^pie(?:\s+showData)?(?:\s+title\s+(.+))?$/.exec(header.text.trim())
  if (!declaration) return fail('饼图开头支持 pie 或 pie showData，可添加 title 标题。', header)
  const showData = /\bshowData\b/.test(header.text), slices: { label: string; value: number; at: Line }[] = []
  let title = declaration[1] ? text(declaration[1], header) : '占比分析', hasTitle = Boolean(declaration[1])
  const labels = new Set<string>()
  for (const at of lines.slice(1)) {
    const value = at.text.trim(), heading = value.match(/^title\s+(.+)$/)
    if (heading) { if (hasTitle) fail('饼图只能设置一个标题。', at); title = text(heading[1]!, at); hasTitle = true; continue }
    const match = value.match(new RegExp(`^("(?:[^"\\\\]|\\\\.)*")\\s*:\\s*(${NUMBER})$`))
    if (!match) fail('饼图数据格式为 "分类名称" : 非负数；其他指令暂不支持。', at)
    const label = text(match![1]!, at), amount = number(match![2]!, at)
    if (amount < 0) fail('饼图数值不能为负数。', at)
    if (labels.has(label)) fail(`饼图分类“${label}”重复。`, at)
    labels.add(label); slices.push({ label, value: amount, at })
    if (slices.length > 64) fail('饼图最多支持 64 个分类。', at)
  }
  const total = slices.reduce((sum, item) => sum + item.value, 0)
  if (!slices.length || total <= 0) fail('饼图需要至少一个正数，所有分类的合计必须大于零。', header)
  const elements: SceneElement[] = [titleNode(title)], cx = 320, cy = 340, radius = 220
  let angle = -Math.PI / 2
  slices.forEach((slice, index) => {
    const fraction = slice.value / total, finish = angle + fraction * Math.PI * 2, color = COLORS[index % COLORS.length]!
    if (fraction > 0) {
      const samples = Math.max(2, Math.ceil(fraction * 160)), points: Point[] = [{ x: cx, y: cy }]
      for (let i = 0; i <= samples; i++) { const theta = angle + (finish - angle) * i / samples; points.push({ x: cx + Math.cos(theta) * radius, y: cy + Math.sin(theta) * radius }) }
      elements.push(diagramStroke(`pie-sector-${index}`, points, style(color), true))
      if (fraction >= .045) {
        const middle = (angle + finish) / 2
        elements.push(diagramText(`pie-percent-${index}`, `${Number((fraction * 100).toFixed(1))}%`, cx + Math.cos(middle) * radius * .67 - 45, cy + Math.sin(middle) * radius * .67 - 15, 90, 30, { fontSize: 17, stroke: '#ffffff' }))
      }
    }
    elements.push(diagramNode(`pie-key-${index}`, '', 600, 120 + index * 39, 18, 18, 'rectangle', style(color, color)))
    elements.push(diagramText(`pie-label-${index}`, `${slice.label}  ${showData ? `${labelNumber(slice.value)} · ` : ''}${Number((fraction * 100).toFixed(1))}%`, 632, 110 + index * 39, 430, 38, { textAlign: 'left', fontSize: 16 }))
    angle = finish
  })
  elements.push(diagramText('pie-total', `合计 ${labelNumber(total)}`, 100, 590, 440, 36, { fontSize: 16, stroke: '#64748b' }))
  return finishDiagram('pie', elements)
}

function date(value: string, at: Line): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return fail('日期必须为 YYYY-MM-DD，或用 after 任务ID 指定依赖。', at)
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return fail(`无效日期“${value}”。`, at)
  const result = Date.UTC(year, month - 1, day), parsed = new Date(result)
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return fail(`无效日期“${value}”。`, at)
  return result
}
function duration(value: string, at: Line, milestone = false): number {
  const match = /^(\d+)(d|w)$/.exec(value)
  if (!match) return fail('任务时长支持整数天 d 或周 w，例如 5d、2w；小时等单位暂不支持。', at)
  const days = Number(match[1]) * (match[2] === 'w' ? 7 : 1)
  if (!Number.isSafeInteger(days) || days > 36525 || days < (milestone ? 0 : 1)) return fail('普通任务时长须为 1–36,525 天；里程碑使用 0d。', at)
  if (milestone && days !== 0) return fail('里程碑时长必须为 0d。', at)
  return days * DAY
}
interface Task {
  id: string; name: string; section: string; at: Line; flags: Set<string>; startExpr: string; finishExpr: string
  previous?: Task; start?: number; end?: number; dependencies: string[]; resolving?: boolean
}
function gantt(lines: Line[]): DiagramResult {
  if (lines[0]!.text.trim() !== 'gantt') return fail('甘特图开头应为 gantt。', lines[0]!)
  let title = '项目计划', section = '', axisFormat = '%m-%d', hasTitle = false, hasDateFormat = false, hasAxisFormat = false
  const tasks: Task[] = [], ids = new Map<string, Task>()
  for (const at of lines.slice(1)) {
    const value = at.text.trim()
    const directive = value.match(/^(title|section|dateFormat|axisFormat)\s+(.+)$/)
    if (directive) {
      const argument = directive[2]!.trim()
      if (directive[1] === 'title') { if (hasTitle) fail('甘特图只能设置一个标题。', at); title = text(argument, at); hasTitle = true }
      else if (directive[1] === 'section') section = text(argument, at)
      else if (directive[1] === 'dateFormat') { if (hasDateFormat) fail('dateFormat 不能重复。', at); if (argument !== 'YYYY-MM-DD') fail('当前甘特图仅支持 dateFormat YYYY-MM-DD。', at); hasDateFormat = true }
      else { if (hasAxisFormat) fail('axisFormat 不能重复。', at); if (!['%Y-%m-%d', '%m-%d', '%d'].includes(argument)) fail('axisFormat 目前支持 %Y-%m-%d、%m-%d 或 %d。', at); axisFormat = argument; hasAxisFormat = true }
      continue
    }
    if (/^(?:excludes|includes|todayMarker|tickInterval|weekend|click|accTitle|accDescr)\b/.test(value)) fail('当前甘特图按连续 UTC 日历日计算；排除日期、标记、交互及该指令暂不支持。', at)
    const match = /^(.+?)\s*:\s*(.+)$/.exec(value)
    if (!match) fail('任务格式为 任务名称 :任务ID, 开始日期或 after 任务ID, 结束日期或时长。', at)
    const parts = commaList(match![2]!, at), flags = new Set<string>()
    while (['done', 'active', 'crit', 'milestone'].includes(parts[0] || '')) { const flag = parts.shift()!; if (flags.has(flag)) fail(`任务标记“${flag}”重复。`, at); flags.add(flag) }
    let id = `task-${tasks.length + 1}`, startExpr = '', finishExpr = ''
    if (parts.length === 3) { [id, startExpr, finishExpr] = parts as [string, string, string] }
    else if (parts.length === 2) {
      if (/^\d{4}-|^after\s/.test(parts[0]!)) [startExpr, finishExpr] = parts as [string, string]
      else { id = parts[0]!; finishExpr = parts[1]! }
    } else if (parts.length === 1) finishExpr = parts[0]!
    else fail('任务参数数量不正确；多个依赖请写为 after a b。', at)
    if (!/^[A-Za-z_][A-Za-z\d_-]*$/.test(id) || ids.has(id)) fail('任务 ID 必须唯一，并以字母或下划线开头。', at)
    const task: Task = { id, name: text(match![1]!, at), section, at, flags, startExpr, finishExpr, previous: tasks.at(-1), dependencies: [] }
    tasks.push(task); ids.set(id, task)
    if (tasks.length > 150) fail('甘特图最多支持 150 个任务。', at)
  }
  if (!tasks.length) fail('甘特图需要至少一个任务。', lines[0]!)
  function resolve(task: Task): void {
    if (task.start !== undefined) return
    if (task.resolving) return fail(`任务“${task.id}”存在循环依赖。`, task.at)
    task.resolving = true
    let start: number
    if (/^after\s+/.test(task.startExpr)) {
      const dependencies = task.startExpr.slice(6).trim().split(/\s+/)
      if (dependencies.length > 10 || dependencies.some(id => !/^[A-Za-z_][A-Za-z\d_-]*$/.test(id))) fail('after 支持最多 10 个任务 ID，以空格分隔。', task.at)
      task.dependencies = [...new Set(dependencies)]
      start = Math.max(...task.dependencies.map(id => { const dependency = ids.get(id); if (!dependency) return fail(`找不到依赖任务“${id}”。`, task.at); resolve(dependency); return dependency.end! }))
    } else if (!task.startExpr) {
      if (!task.previous) return fail('首个任务必须指定开始日期。', task.at)
      resolve(task.previous!); start = task.previous!.end!
    } else start = date(task.startExpr, task.at)
    const milestone = task.flags.has('milestone')
    const end = /^\d{4}-/.test(task.finishExpr) ? date(task.finishExpr, task.at) : start + duration(task.finishExpr, task.at, milestone)
    if (end < start || (!milestone && end === start) || (milestone && end !== start)) fail('任务结束时间必须晚于开始；里程碑的开始和结束必须相同。', task.at)
    if (end > Date.UTC(9999, 11, 31)) fail('任务结束日期超出支持范围。', task.at)
    task.start = start; task.end = end; task.resolving = false
  }
  tasks.forEach(resolve)
  const minimum = Math.min(...tasks.map(task => task.start!)), maximum = Math.max(minimum + DAY, ...tasks.map(task => task.end!)), days = (maximum - minimum) / DAY
  if (days > 36525) fail('甘特图总跨度不能超过 36,525 天。', lines[0]!)
  const elements: SceneElement[] = [titleNode(title)], left = 270, width = 860, positions = new Map<string, { x: number; y: number; right: number }>()
  const x = (time: number) => left + (time - minimum) / (maximum - minimum) * width
  let y = 145, previousSection: string | undefined
  for (const task of tasks) {
    if (task.section !== previousSection) {
      if (task.section) { elements.push(diagramNode(`gantt-section-bg-${task.id}`, '', 60, y - 8, 1090, 36, 'rectangle', { fill: '#f0f4fa', strokeWidth: 0 })); elements.push(diagramText(`gantt-section-${task.id}`, task.section, 70, y - 5, 1050, 30, { textAlign: 'left', fontSize: 16, stroke: '#475569' })); y += 44 }
      previousSection = task.section
    }
    positions.set(task.id, { x: x(task.start!), right: x(task.end!), y })
    y += 48
  }
  const ticks = Math.min(8, Math.ceil(days)), tickDays = Math.max(1, Math.ceil(days / ticks))
  for (let index = 0, offset = 0; offset <= days; index++, offset += tickDays) {
    const time = minimum + offset * DAY, iso = new Date(time).toISOString().slice(0, 10), value = axisFormat === '%Y-%m-%d' ? iso : axisFormat === '%d' ? iso.slice(8) : iso.slice(5)
    elements.push(stroke(`gantt-grid-${index}`, [{ x: x(time), y: 115 }, { x: x(time), y: y - 14 }], { stroke: '#dbe3ef', dashed: true }))
    elements.push(diagramText(`gantt-tick-${index}`, value, x(time) - 50, 82, 100, 28, { fontSize: 13, stroke: '#64748b' }))
  }
  elements.push(stroke('gantt-axis', [{ x: left, y: 114 }, { x: left + width, y: 114 }], { stroke: '#8191a9' }))
  for (const task of tasks) for (const dependency of task.dependencies) {
    const from = positions.get(dependency)!, to = positions.get(task.id)!
    elements.push(diagramEdge(`gantt-dependency-${dependency}-${task.id}`, { x: from.right, y: from.y + 13 }, { x: to.x, y: to.y + 13 }, '', { arrow: 'end', route: 'orthogonal', style: { stroke: '#9aa8be', strokeWidth: 1.5, dashed: true } }))
  }
  for (const task of tasks) {
    const position = positions.get(task.id)!, fill = task.flags.has('crit') ? '#e2828f' : task.flags.has('done') ? '#68b89d' : task.flags.has('active') ? '#6389e7' : '#9b8ad1'
    elements.push(diagramText(`gantt-name-${task.id}`, task.name, 70, position.y - 3, 190, 34, { fontSize: 14, textAlign: 'left' }))
    const milestone = task.flags.has('milestone'), barWidth = Math.max(3, position.right - position.x)
    elements.push(diagramNode(`gantt-task-${task.id}`, '', milestone ? position.x - 11 : position.x, position.y, milestone ? 22 : barWidth, 26, milestone ? 'diamond' : 'rectangle', { fill, stroke: fill, strokeWidth: 1 }))
    const summary = milestone ? '里程碑' : `${new Date(task.start!).toISOString().slice(0, 10)} · ${(task.end! - task.start!) / DAY} 天`
    elements.push(diagramText(`gantt-detail-${task.id}`, summary, position.x + 5, position.y + 27, Math.max(160, barWidth), 18, { fontSize: 10, textAlign: 'left', stroke: '#64748b' }))
  }
  elements.push(diagramText('gantt-calendar-note', 'UTC 连续日历日 · 结束日期为不包含的边界 · 未排除周末或节假日', 70, y + 10, 1060, 34, { textAlign: 'left', fontSize: 13, stroke: '#64748b' }))
  return finishDiagram('gantt', elements)
}

interface Axis { title: string; categories?: string[]; minimum?: number; maximum?: number; at: Line }
function axis(value: string, at: Line, isX: boolean): Axis {
  const array = /^(.*?)\[([\s\S]*)\]$/.exec(value)
  if (array) {
    if (!isX) return fail('y-axis 目前只支持数值范围。', at)
    const categories = commaList(array[2]!, at).map(item => text(item, at))
    if (categories.length > 100) return fail('X 轴最多支持 100 个分类。', at)
    return { title: array[1]!.trim() ? text(array[1]!, at) : '', categories, at }
  }
  const range = new RegExp(`^(?:(.*?)\\s+)?(${NUMBER})\\s*-->\\s*(${NUMBER})$`).exec(value)
  if (range) {
    const minimum = number(range[2]!, at), maximum = number(range[3]!, at)
    if (minimum >= maximum) return fail('坐标轴范围的结束值必须大于起始值。', at)
    return { title: range[1]?.trim() ? text(range[1], at) : '', minimum, maximum, at }
  }
  if (/[\[\]]|-->/.test(value)) return fail('坐标轴格式无效，支持 [分类列表] 或 最小值 --> 最大值。', at)
  return { title: value.trim() ? text(value, at) : '', at }
}
function xyChart(lines: Line[]): DiagramResult {
  const match = /^xychart(?:-beta)?(?:\s+(horizontal))?$/.exec(lines[0]!.text.trim())
  if (!match) return fail('XY 图开头支持 xychart-beta，可添加 horizontal。', lines[0]!)
  const horizontal = Boolean(match[1]), series: { type: 'bar' | 'line'; values: number[]; at: Line }[] = []
  let title = '数据趋势', hasTitle = false, xAxis: Axis | undefined, yAxis: Axis | undefined
  for (const at of lines.slice(1)) {
    const value = at.text.trim(), heading = /^title\s+(.+)$/.exec(value)
    if (heading) { if (hasTitle) fail('XY 图只能设置一个标题。', at); title = text(heading[1]!, at); hasTitle = true; continue }
    const declaration = /^([xy])-axis(?:\s+(.*))?$/.exec(value)
    if (declaration) {
      const isX = declaration[1] === 'x'
      if (isX ? xAxis : yAxis) fail('同一个坐标轴不能重复声明。', at)
      const result = axis(declaration[2] || '', at, isX)
      if (isX) xAxis = result; else yAxis = result
      continue
    }
    const data = /^(bar|line)\s*\[([^\]]*)\]$/.exec(value)
    if (!data) fail('XY 图支持 title、x-axis、y-axis、bar [数值] 和 line [数值]。', at)
    const values = commaList(data![2]!, at).map(item => number(item, at))
    if (values.length > 100) fail('每条数据序列最多支持 100 个数值。', at)
    series.push({ type: data![1] as 'bar' | 'line', values, at })
    if (series.length > 8) fail('XY 图最多支持 8 条数据序列。', at)
  }
  if (!series.length) fail('XY 图需要至少一组 bar 或 line 数据。', lines[0]!)
  const count = series[0]!.values.length
  for (const item of series) if (item.values.length !== count) fail('所有数据序列的长度必须相同。', item.at)
  if (xAxis?.categories && xAxis.categories.length !== count) fail('X 轴分类数量必须与数据序列长度一致。', xAxis.at)
  const values = series.flatMap(item => item.values)
  let minimum = yAxis?.minimum ?? Math.min(0, ...values), maximum = yAxis?.maximum ?? Math.max(0, ...values)
  if (maximum === minimum) { minimum -= 1; maximum += 1 }
  for (const item of series) if (item.values.some(value => value < minimum || value > maximum)) fail('数据超出了 y-axis 的声明范围，请扩大范围。', item.at)
  const left = 160, top = 130, width = 800, height = 430, elements: SceneElement[] = [titleNode(title)]
  const t = (index: number): number => xAxis?.minimum !== undefined && count > 1 ? index / (count - 1) : (index + .5) / count
  const point = (index: number, value: number): Point => horizontal
    ? { x: left + (value - minimum) / (maximum - minimum) * width, y: top + t(index) * height }
    : { x: left + t(index) * width, y: top + height - (value - minimum) / (maximum - minimum) * height }
  const baseline = Math.max(minimum, Math.min(maximum, 0)), base = point(0, baseline)
  for (let index = 0; index <= 5; index++) {
    const value = minimum + (maximum - minimum) * index / 5, p = point(0, value)
    elements.push(stroke(`xy-grid-${index}`, horizontal ? [{ x: p.x, y: top }, { x: p.x, y: top + height }] : [{ x: left, y: p.y }, { x: left + width, y: p.y }], { stroke: '#e1e7f0' }))
    elements.push(diagramText(`xy-y-tick-${index}`, labelNumber(value), horizontal ? p.x - 55 : left - 115, horizontal ? top + height + 16 : p.y - 14, 100, 28, { fontSize: 13, textAlign: horizontal ? 'center' : 'right', stroke: '#64748b' }))
  }
  const stride = Math.max(1, Math.ceil(count / 16))
  for (let index = 0; index < count; index++) if (index % stride === 0 || index === count - 1) {
    const value = xAxis?.categories?.[index] ?? (xAxis?.minimum !== undefined ? labelNumber(xAxis.minimum + (xAxis.maximum! - xAxis.minimum) * (count > 1 ? index / (count - 1) : .5)) : String(index + 1)), p = point(index, minimum)
    elements.push(diagramText(`xy-x-tick-${index}`, value, horizontal ? left - 140 : p.x - 45, horizontal ? p.y - 17 : top + height + 16, horizontal ? 125 : 90, 34, { fontSize: 13, textAlign: horizontal ? 'right' : 'center', stroke: '#64748b' }))
  }
  elements.push(stroke('xy-axis-bottom', [{ x: left, y: top + height }, { x: left + width, y: top + height }], { stroke: '#8091ac', strokeWidth: 1.5 }))
  elements.push(stroke('xy-axis-left', [{ x: left, y: top }, { x: left, y: top + height }], { stroke: '#8091ac', strokeWidth: 1.5 }))
  if (baseline !== minimum) elements.push(stroke('xy-zero', horizontal ? [{ x: base.x, y: top }, { x: base.x, y: top + height }] : [{ x: left, y: base.y }, { x: left + width, y: base.y }], { stroke: '#a3afc0', dashed: true }))
  if (xAxis?.title) elements.push(diagramText('xy-x-title', xAxis.title, horizontal ? 10 : left, horizontal ? 82 : top + height + 62, horizontal ? 140 : width, 35, { fontSize: 16, stroke: '#475569' }))
  if (yAxis?.title) elements.push(diagramText('xy-y-title', yAxis.title, horizontal ? left : 10, horizontal ? top + height + 62 : 82, horizontal ? width : 300, 35, { fontSize: 16, textAlign: horizontal ? 'center' : 'left', stroke: '#475569' }))
  const barCount = series.filter(item => item.type === 'bar').length, band = (horizontal ? height : width) / count * .7
  let barIndex = 0
  series.forEach((item, seriesIndex) => {
    const color = COLORS[seriesIndex % COLORS.length]!, points = item.values.map((value, index) => point(index, value))
    if (item.type === 'bar') {
      const thickness = band / barCount, offset = -band / 2 + barIndex++ * thickness
      points.forEach((p, index) => {
        const origin = point(index, baseline)
        if (item.values[index] === baseline) return
        const x = horizontal ? Math.min(p.x, origin.x) : p.x + offset, y = horizontal ? p.y + offset : Math.min(p.y, origin.y)
        const width = horizontal ? Math.abs(p.x - origin.x) : thickness, height = horizontal ? thickness : Math.abs(p.y - origin.y)
        const appearance: Partial<ElementStyle> = { fill: color, stroke: color, strokeWidth: 0, opacity: .85 }, id = `xy-bar-${seriesIndex}-${index}`
        // Tiny values retain their real proportions without violating the
        // editable rectangle's minimum size or widening adjacent bar groups.
        elements.push(width >= 1 && height >= 1 ? diagramNode(id, '', x, y, width, height, 'rectangle', appearance)
          : diagramStroke(id, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], appearance, true))
      })
    } else {
      if (points.length > 1) elements.push(stroke(`xy-line-${seriesIndex}`, points, { stroke: color, strokeWidth: 3 }))
      points.forEach((p, index) => elements.push(diagramNode(`xy-point-${seriesIndex}-${index}`, '', p.x - 3, p.y - 3, 6, 6, 'ellipse', { fill: color, stroke: '#ffffff', strokeWidth: 1 })))
    }
    elements.push(diagramNode(`xy-key-${seriesIndex}`, '', left + seriesIndex % 4 * 205, top + height + 115 + Math.floor(seriesIndex / 4) * 34, 18, 12, 'rectangle', style(color, color)))
    elements.push(diagramText(`xy-legend-${seriesIndex}`, `${item.type === 'bar' ? '柱形' : '折线'}序列 ${seriesIndex + 1}`, left + seriesIndex % 4 * 205 + 27, top + height + 104 + Math.floor(seriesIndex / 4) * 34, 165, 32, { textAlign: 'left', fontSize: 14 }))
  })
  return finishDiagram('xychart', elements)
}

function quadrant(lines: Line[]): DiagramResult {
  if (lines[0]!.text.trim() !== 'quadrantChart') return fail('象限图开头应为 quadrantChart。', lines[0]!)
  let title = '优先级分析', xLabels = ['较低', '较高'], yLabels = ['较低', '较高']
  const quadrants = ['第一象限', '第二象限', '第三象限', '第四象限'], declarations = new Set<string>(), points: { name: string; x: number; y: number }[] = []
  for (const at of lines.slice(1)) {
    const value = at.text.trim(), heading = /^title\s+(.+)$/.exec(value)
    if (heading) { if (declarations.has('title')) fail('象限图只能设置一个标题。', at); declarations.add('title'); title = text(heading[1]!, at); continue }
    const declaration = /^(x-axis|y-axis|quadrant-[1-4])\s+(.+)$/.exec(value)
    if (declaration) {
      const key = declaration[1]!
      if (declarations.has(key)) fail(`“${key}”不能重复声明。`, at)
      declarations.add(key)
      if (key.startsWith('quadrant-')) quadrants[Number(key.slice(-1)) - 1] = text(declaration[2]!, at)
      else {
        const pair = declaration[2]!.split(/\s*-->\s*/)
        if (pair.length !== 2) fail('象限坐标轴格式为 x-axis 较低 --> 较高。', at)
        const labels = pair.map(value => text(value, at))
        if (key === 'x-axis') xLabels = labels; else yLabels = labels
      }
      continue
    }
    const match = new RegExp(`^(.+?)\\s*:\\s*\\[\\s*(${NUMBER})\\s*,\\s*(${NUMBER})\\s*\\]$`).exec(value)
    if (!match) fail('象限数据格式为 名称: [x, y]，坐标范围为 0 到 1；样式指令暂不支持。', at)
    const x = number(match![2]!, at), y = number(match![3]!, at)
    if (x < 0 || x > 1 || y < 0 || y > 1) fail('象限图坐标必须在 0 到 1 之间。', at)
    points.push({ name: text(match![1]!, at), x, y })
    if (points.length > 100) fail('象限图最多支持 100 个数据点。', at)
  }
  if (!points.length) fail('象限图需要至少一个数据点。', lines[0]!)
  const elements: SceneElement[] = [titleNode(title)], left = 180, top = 130, width = 760, height = 500
  const boxes = [{ x: left + width / 2, y: top, fill: '#e3f3ed' }, { x: left, y: top, fill: '#e8effc' }, { x: left, y: top + height / 2, fill: '#f0eafa' }, { x: left + width / 2, y: top + height / 2, fill: '#fff2da' }]
  boxes.forEach((box, index) => {
    elements.push(diagramNode(`quadrant-area-${index + 1}`, '', box.x, box.y, width / 2, height / 2, 'rectangle', { fill: box.fill, stroke: '#ffffff', strokeWidth: 1 }))
    elements.push(diagramText(`quadrant-title-${index + 1}`, quadrants[index]!, box.x + 12, box.y + 12, width / 2 - 24, 34, { fontSize: 17, stroke: '#738197' }))
  })
  elements.push(stroke('quadrant-x-mid', [{ x: left, y: top + height / 2 }, { x: left + width, y: top + height / 2 }], { stroke: '#8a9bb2', dashed: true }))
  elements.push(stroke('quadrant-y-mid', [{ x: left + width / 2, y: top }, { x: left + width / 2, y: top + height }], { stroke: '#8a9bb2', dashed: true }))
  elements.push(diagramText('quadrant-x-low', xLabels[0]!, left, top + height + 14, width / 2, 40, { textAlign: 'left', stroke: '#475569' }))
  elements.push(diagramText('quadrant-x-high', xLabels[1]!, left + width / 2, top + height + 14, width / 2, 40, { textAlign: 'right', stroke: '#475569' }))
  elements.push(diagramText('quadrant-y-low', yLabels[0]!, 15, top + height - 50, 150, 40, { textAlign: 'right', stroke: '#475569' }))
  elements.push(diagramText('quadrant-y-high', yLabels[1]!, 15, top, 150, 40, { textAlign: 'right', stroke: '#475569' }))
  points.forEach((point, index) => {
    const x = left + point.x * width, y = top + (1 - point.y) * height
    elements.push(diagramNode(`quadrant-point-${index}`, '', x - 6, y - 6, 12, 12, 'ellipse', { fill: '#526da5', stroke: '#ffffff', strokeWidth: 2 }))
    elements.push(diagramText(`quadrant-label-${index}`, point.name, point.x > .75 ? x - 184 : x + 13, y - 18, 170, 36, { fontSize: 14, textAlign: point.x > .75 ? 'right' : 'left', stroke: '#334155' }))
  })
  return finishDiagram('quadrant', elements)
}

function csv(value: string, at: Line): string[] {
  const fields: string[] = []
  let index = 0
  while (index < value.length) {
    while (value[index] === ' ') index++
    let field = ''
    if (value[index] === '"') {
      index++; let closed = false
      while (index < value.length) {
        if (value[index] === '"') { if (value[index + 1] === '"') { field += '"'; index += 2; continue }; closed = true; index++; break }
        field += value[index++]
      }
      if (!closed) fail('CSV 双引号未闭合；暂不支持跨行字段。', at)
      while (value[index] === ' ') index++
      if (index < value.length && value[index] !== ',') fail('CSV 引号后只能接逗号。', at)
    } else {
      while (index < value.length && value[index] !== ',') { if (value[index] === '"') fail('CSV 引号须位于字段开头。', at); field += value[index++] }
      field = field.trim()
    }
    if (!field || field.length > 2000) fail('CSV 字段不能为空或超过 2,000 字符。', at)
    fields.push(field)
    if (value[index] === ',') { index++; if (index === value.length) fail('CSV 末尾不能有空字段。', at) }
  }
  return fields
}
function sankey(lines: Line[]): DiagramResult {
  if (!/^sankey(?:-beta)?$/.test(lines[0]!.text.trim())) return fail('桑基图开头应为 sankey-beta。', lines[0]!)
  const nodes = new Map<string, { id: number; name: string; input: number; output: number; rank: number; incoming: number; x: number; y: number; height: number }>()
  const links: { source: string; target: string; value: number; at: Line; from?: number; to?: number }[] = []
  function node(name: string) {
    if (!nodes.has(name)) nodes.set(name, { id: nodes.size, name, input: 0, output: 0, rank: 0, incoming: 0, x: 0, y: 0, height: 0 })
    return nodes.get(name)!
  }
  for (const at of lines.slice(1)) {
    const fields = csv(at.text.trim(), at)
    if (fields.length !== 3) fail('桑基图每行必须为 来源,去向,数值 三个 CSV 字段。', at)
    const value = number(fields[2]!, at)
    if (value <= 0) fail('桑基图流量必须大于零。', at)
    if (fields[0] === fields[1]) fail('桑基图不支持自身回流。', at)
    const from = node(fields[0]!), to = node(fields[1]!)
    from.output += value; to.input += value; to.incoming++
    links.push({ source: from.name, target: to.name, value, at })
    if (nodes.size > 60 || links.length > 120) fail('桑基图最多支持 60 个节点和 120 条流向。', at)
  }
  if (!links.length) fail('桑基图需要至少一条流向。', lines[0]!)
  const queue = [...nodes.values()].filter(item => !item.incoming)
  for (let i = 0; i < queue.length; i++) for (const link of links.filter(link => link.source === queue[i]!.name)) {
    const target = nodes.get(link.target)!
    target.rank = Math.max(target.rank, queue[i]!.rank + 1)
    if (--target.incoming === 0) queue.push(target)
  }
  if (queue.length !== nodes.size) fail('桑基图存在循环流向；当前支持无环的分层流向。', links.find(link => nodes.get(link.target)!.incoming > 0)!.at)
  const layers = new Map<number, typeof queue>()
  for (const item of nodes.values()) layers.set(item.rank, [...(layers.get(item.rank) || []), item])
  const gap = 26, plotHeight = Math.max(480, ...[...layers.values()].map(items => items.length * 42)), top = 125
  const scale = Math.min(...[...layers.values()].map(items => (plotHeight - gap * (items.length - 1)) / items.reduce((sum, item) => sum + Math.max(item.input, item.output), 0)))
  const warnings: string[] = []
  for (const [rank, items] of layers) {
    const total = items.reduce((sum, item) => sum + Math.max(item.input, item.output) * scale, 0) + gap * (items.length - 1)
    let y = top + (plotHeight - total) / 2
    for (const item of items) { item.x = 100 + rank * 260; item.y = y; item.height = Math.max(item.input, item.output) * scale; y += item.height + gap }
  }
  for (const item of nodes.values()) {
    let output = 0, input = 0
    for (const link of links.filter(link => link.source === item.name).sort((a, b) => nodes.get(a.target)!.y - nodes.get(b.target)!.y)) { link.from = item.y + output; output += link.value * scale }
    for (const link of links.filter(link => link.target === item.name).sort((a, b) => nodes.get(a.source)!.y - nodes.get(b.source)!.y)) { link.to = item.y + input; input += link.value * scale }
  }
  const elements: SceneElement[] = [titleNode('流向与分配')]
  links.forEach((link, index) => {
    const from = nodes.get(link.source)!, to = nodes.get(link.target)!, thickness = link.value * scale, points: Point[] = [], x0 = from.x + 20, x1 = to.x
    const sample = (t: number, bottom: boolean): Point => {
      const smooth = t * t * (3 - 2 * t)
      return { x: x0 + (x1 - x0) * t, y: link.from! + (link.to! - link.from!) * smooth + (bottom ? thickness : 0) }
    }
    for (let j = 0; j <= 24; j++) points.push(sample(j / 24, false))
    for (let j = 24; j >= 0; j--) points.push(sample(j / 24, true))
    elements.push(diagramStroke(`sankey-flow-${index}`, points, { fill: COLORS[from.id % COLORS.length], stroke: 'none', strokeWidth: 0, opacity: .48 }, true))
  })
  for (const item of nodes.values()) {
    if (item.height < 1) warnings.push('极小流量节点使用最小可见高度，流带仍按实际比例绘制。')
    elements.push(diagramNode(`sankey-node-${item.id}`, '', item.x, item.y, 20, Math.max(1, item.height), 'rectangle', { fill: COLORS[item.id % COLORS.length], strokeWidth: 0 }))
    const summary = item.input && item.output && item.input !== item.output ? `入 ${labelNumber(item.input)} / 出 ${labelNumber(item.output)}` : labelNumber(Math.max(item.input, item.output))
    elements.push(diagramText(`sankey-label-${item.id}`, `${item.name}\n${summary}`, item.x + 28, item.y + item.height / 2 - 28, 210, 56, { fontSize: 14, textAlign: 'left' }))
  }
  return finishDiagram('sankey', elements, warnings)
}

function structuredList(value: string, at: Line): string[] {
  const result: string[] = [], brackets: string[] = []
  let start = 0, quoted = false, escaped = false
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!
    if (escaped) { escaped = false; continue }
    if (quoted && char === '\\') { escaped = true; continue }
    if (char === '"') { quoted = !quoted; continue }
    if (quoted) continue
    if ('[{'.includes(char)) brackets.push(char)
    if (']}'.includes(char)) { const expected = char === ']' ? '[' : '{'; if (brackets.pop() !== expected) fail('括号不匹配。', at) }
    if (char === ',' && !brackets.length) { result.push(value.slice(start, i).trim()); start = i + 1 }
  }
  if (quoted || brackets.length) fail('文字或括号未闭合。', at)
  result.push(value.slice(start).trim())
  if (result.some(value => !value)) fail('列表不能包含空项。', at)
  return result
}
function radarDescriptor(value: string, at: Line): { id: string; label: string } {
  const match = /^([A-Za-z_][A-Za-z\d_-]*)(?:\[\s*("(?:[^"\\]|\\.)*")\s*\])?$/.exec(value.trim())
  if (!match) return fail('雷达轴或曲线格式为 id 或 id["显示名称"]。', at)
  return { id: match[1]!, label: match[2] ? text(match[2], at) : match[1]! }
}
function radar(lines: Line[]): DiagramResult {
  if (!/^radar(?:-beta)?$/.test(lines[0]!.text.trim())) return fail('雷达图开头应为 radar-beta。', lines[0]!)
  const axes: { id: string; label: string }[] = [], curves: { id: string; label: string; raw: string[]; at: Line; values: number[] }[] = [], declarations = new Set<string>()
  let title = '多维能力比较', minimum = 0, maximum: number | undefined, ticks = 5, polygon = false, showLegend = true
  for (const at of lines.slice(1)) {
    const value = at.text.trim()
    if (value.startsWith('axis ')) {
      for (const entry of structuredList(value.slice(5), at)) { const descriptor = radarDescriptor(entry, at); if (axes.some(axis => axis.id === descriptor.id)) fail('雷达轴 ID 不能重复。', at); axes.push(descriptor) }
      if (axes.length > 30) fail('雷达图最多支持 30 个轴。', at)
      continue
    }
    if (value.startsWith('curve ')) {
      for (const entry of structuredList(value.slice(6), at)) {
        const match = /^(.*?)\{([^{}]*)\}$/.exec(entry)
        if (!match) fail('曲线格式为 curve id["名称"]{数值列表}。', at)
        const descriptor = radarDescriptor(match![1]!, at)
        if (curves.some(curve => curve.id === descriptor.id)) fail('曲线 ID 不能重复。', at)
        curves.push({ ...descriptor, raw: commaList(match![2]!, at), at, values: [] })
      }
      if (curves.length > 8) fail('雷达图最多支持 8 条曲线。', at)
      continue
    }
    const directive = /^(title|min|max|ticks|graticule|showLegend)\s+(.+)$/.exec(value)
    if (!directive) fail('雷达图支持 axis、curve、title、min、max、ticks、graticule 和 showLegend。', at)
    const key = directive![1]!, argument = directive![2]!.trim()
    if (declarations.has(key)) fail(`“${key}”不能重复声明。`, at)
    declarations.add(key)
    if (key === 'title') title = text(argument, at)
    else if (key === 'min') minimum = number(argument, at)
    else if (key === 'max') maximum = number(argument, at)
    else if (key === 'ticks') { ticks = number(argument, at); if (!Number.isInteger(ticks) || ticks < 1 || ticks > 12) fail('ticks 必须为 1 到 12 的整数。', at) }
    else if (key === 'graticule') { if (!['circle', 'polygon'].includes(argument)) fail('graticule 支持 circle 或 polygon。', at); polygon = argument === 'polygon' }
    else { if (!['true', 'false'].includes(argument)) fail('showLegend 必须为 true 或 false。', at); showLegend = argument === 'true' }
  }
  if (axes.length < 3 || !curves.length) fail('雷达图需要至少 3 个轴和 1 条曲线。', lines[0]!)
  for (const curve of curves) {
    if (curve.raw.some(value => value.includes(':'))) {
      const pairs = new Map<string, number>()
      for (const item of curve.raw) { const match = /^([A-Za-z_][A-Za-z\d_-]*)\s*:\s*(.+)$/.exec(item); if (!match || !axes.some(axis => axis.id === match[1])) fail('曲线数据引用了未知的轴，或混合了两种数值写法。', curve.at); if (pairs.has(match![1]!)) fail('曲线中的轴 ID 不能重复。', curve.at); pairs.set(match![1]!, number(match![2]!, curve.at)) }
      if (pairs.size !== axes.length) fail('每条曲线必须提供全部轴的数值。', curve.at)
      curve.values = axes.map(axis => pairs.get(axis.id)!)
    } else { if (curve.raw.length !== axes.length) fail('曲线数值数量必须与轴数量一致。', curve.at); curve.values = curve.raw.map(value => number(value, curve.at)) }
  }
  maximum ??= Math.max(minimum + 1, ...curves.flatMap(curve => curve.values))
  if (minimum >= maximum) fail('雷达图 max 必须大于 min。', lines[0]!)
  for (const curve of curves) if (curve.values.some(value => value < minimum || value > maximum!)) fail('曲线数值超出了 min/max 的范围。', curve.at)
  const elements: SceneElement[] = [titleNode(title)], cx = 420, cy = 390, radius = 240
  const point = (index: number, amount: number): Point => ({ x: cx + Math.cos(-Math.PI / 2 + index * Math.PI * 2 / axes.length) * amount, y: cy + Math.sin(-Math.PI / 2 + index * Math.PI * 2 / axes.length) * amount })
  for (let index = 1; index <= ticks; index++) {
    const r = radius * index / ticks
    elements.push(polygon ? diagramStroke(`radar-grid-${index}`, axes.map((_, i) => point(i, r)), { fill: 'none', stroke: '#d2dce9', strokeWidth: 1 }, true) : diagramNode(`radar-grid-${index}`, '', cx - r, cy - r, r * 2, r * 2, 'ellipse', { fill: 'none', stroke: '#d2dce9', strokeWidth: 1 }))
    elements.push(diagramText(`radar-tick-${index}`, labelNumber(minimum + (maximum - minimum) * index / ticks), cx + 6, cy - r - 16, 95, 26, { fontSize: 11, textAlign: 'left', stroke: '#718099' }))
  }
  axes.forEach((axis, index) => {
    const end = point(index, radius), label = point(index, radius + 42)
    elements.push(stroke(`radar-axis-${axis.id}`, [{ x: cx, y: cy }, end], { stroke: '#b9c5d6' }))
    elements.push(diagramText(`radar-label-${axis.id}`, axis.label, label.x - 90, label.y - 18, 180, 36, { fontSize: 15 }))
  })
  curves.forEach((curve, index) => {
    const color = COLORS[index]!, points = curve.values.map((value, i) => point(i, radius * (value - minimum) / (maximum - minimum)))
    elements.push(diagramStroke(`radar-curve-${curve.id}`, points, { fill: color, stroke: color, strokeWidth: 2.5, opacity: .3 }, true))
    points.forEach((p, i) => elements.push(diagramNode(`radar-point-${curve.id}-${i}`, '', p.x - 3, p.y - 3, 6, 6, 'ellipse', { fill: color, stroke: color, strokeWidth: 1 })))
    if (showLegend) {
      elements.push(diagramNode(`radar-key-${curve.id}`, '', 810, 150 + index * 42, 18, 18, 'rectangle', style(color, color)))
      elements.push(diagramText(`radar-legend-${curve.id}`, curve.label, 842, 140 + index * 42, 240, 38, { textAlign: 'left', fontSize: 15 }))
    }
  })
  return finishDiagram('radar', elements)
}

interface TreeEntry { id: number; name: string; at: Line; indent: number; children: TreeEntry[]; value?: number; childIndent?: number }
function treemap(lines: Line[]): DiagramResult {
  if (!/^treemap(?:-beta)?$/.test(lines[0]!.text.trim())) return fail('树图开头应为 treemap-beta。', lines[0]!)
  const root: TreeEntry = { id: -1, name: '', at: lines[0]!, indent: -1, children: [] }, stack = [root]
  let count = 0, previous: TreeEntry | undefined
  for (const at of lines.slice(1)) {
    if (/^\s*\t/.test(at.text) || /^[ \t]*\t/.test(at.text)) fail('树图缩进请使用空格，不支持制表符。', at)
    const indent = at.text.length - at.text.trimStart().length, match = new RegExp(`^("(?:[^"\\\\]|\\\\.)*")(?:\\s*:\\s*(${NUMBER}))?$`).exec(at.text.trim())
    if (!match) fail('树图分组格式为 "名称"，叶子格式为 "名称": 正数；样式类暂不支持。', at)
    if (previous && indent > previous.indent && previous.value !== undefined) fail('带数值的叶子不能再包含子项。', at)
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop()
    const parent = stack.at(-1)!
    if (parent.childIndent !== undefined && parent.childIndent !== indent) fail('同一分组的直接子项必须使用一致缩进。', at)
    parent.childIndent = indent
    const value = match![2] === undefined ? undefined : number(match![2], at)
    if (value !== undefined && value <= 0) fail('树图叶子的数值必须大于零。', at)
    const entry: TreeEntry = { id: count++, name: text(match![1]!, at), at, indent, value, children: [] }
    parent.children.push(entry); previous = entry
    if (value === undefined) stack.push(entry)
    if (count > 200 || stack.length > 11) fail('树图最多支持 200 个条目和 10 层嵌套。', at)
  }
  if (!root.children.length) fail('树图至少需要一个带正数的叶子。', lines[0]!)
  function total(entry: TreeEntry): number {
    if (entry.value !== undefined) return entry.value
    if (!entry.children.length) return fail(`分组“${entry.name}”没有叶子数据。`, entry.at)
    entry.value = entry.children.reduce((sum, child) => sum + total(child), 0)
    return entry.value
  }
  total(root)
  const elements: SceneElement[] = [titleNode(root.children.length === 1 && root.children[0]!.children.length ? root.children[0]!.name : '层级面积图')], warnings: string[] = []
  const leaves: { entry: TreeEntry; path: string; color: string }[] = []
  function layout(entry: TreeEntry, x: number, y: number, width: number, height: number, branch: number, path: string[]): void {
    if (!entry.children.length) {
      const color = COLORS[Math.max(0, branch) % COLORS.length]!
      elements.push(diagramStroke(`treemap-leaf-${entry.id}`, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], { fill: color, stroke: '#ffffff', strokeWidth: 1.5 }, true))
      if (width >= 70 && height >= 64) elements.push(diagramText(`treemap-label-${entry.id}`, `${entry.name}\n${labelNumber(entry.value!)}`, x + 4, y + height / 2 - 32, width - 8, 64, { fontSize: 14, stroke: '#ffffff' }))
      else warnings.push('部分区块较小，名称和数值显示在右侧明细中。')
      leaves.push({ entry, path: [...path, entry.name].join(' / '), color }); return
    }
    let offset = 0
    entry.children.forEach((child, index) => {
      const fraction = child.value! / entry.value!, span = (width >= height ? width : height) * fraction
      const childBranch = branch < 0 ? (entry.children.length > 1 ? index : -1) : branch
      layout(child, width >= height ? x + offset : x, width >= height ? y : y + offset, width >= height ? span : width, width >= height ? height : span, childBranch, entry === root ? [] : [...path, entry.name])
      offset += span
    })
    if (entry !== root) elements.push(diagramStroke(`treemap-group-${entry.id}`, [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }], { fill: 'none', stroke: '#ffffff', strokeWidth: 4 }, true))
  }
  layout(root, 80, 125, 980, 580, -1, [])
  leaves.forEach(({ entry, path, color }, index) => {
    elements.push(diagramNode(`treemap-key-${entry.id}`, '', 1100, 130 + index * 34, 14, 14, 'rectangle', style(color, color)))
    elements.push(diagramText(`treemap-detail-${entry.id}`, `${path}  ${labelNumber(entry.value!)} · ${Number((entry.value! / root.value! * 100).toFixed(1))}%`, 1125, 118 + index * 34, 510, 36, { textAlign: 'left', fontSize: 13 }))
  })
  return finishDiagram('treemap', elements, warnings)
}

/** Returns undefined for diagram families owned by other parsers. */
export function compileChartDiagram(source: string): DiagramResult | undefined {
  const lines = sourceLines(source), header = lines[0]
  if (!header || !/^(?:pie|gantt|xychart(?:-beta)?|quadrantChart|sankey(?:-beta)?|radar(?:-beta)?|treemap(?:-beta)?)\b/.test(header.text.trim())) return undefined
  if (source.length > 200000 || lines.length > 2000) fail('图表源码超过 200,000 字符或 2,000 行。', header)
  if (/^pie\b/.test(header.text.trim())) return pie(lines)
  if (/^gantt\b/.test(header.text.trim())) return gantt(lines)
  if (/^xychart(?:-beta)?\b/.test(header.text.trim())) return xyChart(lines)
  if (/^sankey(?:-beta)?\b/.test(header.text.trim())) return sankey(lines)
  if (/^radar(?:-beta)?\b/.test(header.text.trim())) return radar(lines)
  if (/^treemap(?:-beta)?\b/.test(header.text.trim())) return treemap(lines)
  return quadrant(lines)
}

export const CHART_TEMPLATES: DiagramTemplate[] = [
  { id: 'pie', title: '资源分配饼图', description: '按真实比例绘制扇形，展示分类、数值与占比。', category: '数据图表', source: `pie showData
  title 团队时间分配
  "产品设计" : 28
  "功能开发" : 42
  "测试验证" : 18
  "文档与沟通" : 12` },
  { id: 'gantt', title: '项目交付甘特图', description: '连续日期时间轴、分组任务、前置依赖与交付里程碑。', category: '项目计划', source: `gantt
  title 项目交付计划
  dateFormat YYYY-MM-DD
  axisFormat %m-%d
  section 规划
  需求梳理 :done, requirements, 2026-10-05, 3d
  方案设计 :active, design, after requirements, 4d
  section 实施
  核心功能 :crit, core, after design, 8d
  使用文档 :docs, after design, 5d
  集成验收 :verify, after core docs, 3d
  正式交付 :milestone, release, after verify, 0d` },
  { id: 'xychart', title: '产出趋势组合图', description: '分类坐标轴、并列柱形与折线，比较多组数据。', category: '数据图表', source: `xychart-beta
  title "每月交付与目标"
  x-axis "月份" ["一月", "二月", "三月", "四月", "五月", "六月"]
  y-axis "交付数量" 0 --> 100
  bar [35, 48, 42, 64, 76, 88]
  bar [28, 39, 45, 52, 62, 73]
  line [40, 45, 50, 60, 70, 85]` },
  { id: 'quadrant', title: '价值与投入象限图', description: '用二维坐标安排优先级，区分四个行动区域。', category: '分析决策', source: `quadrantChart
  title 需求优先级
  x-axis 投入较低 --> 投入较高
  y-axis 价值较低 --> 价值较高
  quadrant-1 重点项目
  quadrant-2 优先推进
  quadrant-3 顺手改善
  quadrant-4 谨慎评估
  搜索优化: [0.22, 0.82]
  协作能力: [0.78, 0.87]
  文案调整: [0.18, 0.24]
  特殊报表: [0.81, 0.27]
  导出改进: [0.46, 0.61]` },
  { id: 'sankey', title: '资源流向桑基图', description: '按数值比例展示资源从来源经过中间环节流向去向。', category: '数据图表', source: `sankey-beta
%% 来源,去向,数值
预算,产品研发,60
预算,客户服务,25
预算,运营保障,15
产品研发,核心能力,40
产品研发,体验改进,20
客户服务,体验改进,10
客户服务,知识支持,15
运营保障,稳定性,15` },
  { id: 'radar', title: '多维能力雷达图', description: '在统一数值尺度上比较多个对象，支持轴别名与键值数据。', category: '数据图表', source: `radar-beta
  title 团队能力比较
  axis planning["规划"], delivery["交付"], quality["质量"]
  axis teamwork["协作"], learning["学习"]
  curve current["当前水平"]{75, 85, 70, 90, 80}
  curve target["目标水平"]{planning: 90, delivery: 90, quality: 90, teamwork: 95, learning: 90}
  min 0
  max 100
  ticks 5
  graticule polygon
  showLegend true` },
  { id: 'treemap', title: '投入结构面积树图', description: '由缩进建立层级，让叶子区块面积与实际数值成比例。', category: '数据图表', source: `treemap-beta
"项目投入"
  "研发"
    "产品设计": 18
    "功能开发": 32
    "测试验证": 15
  "运营"
    "用户服务": 12
    "内容建设": 8
  "基础设施"
    "运行环境": 10
    "数据备份": 5` },
]
