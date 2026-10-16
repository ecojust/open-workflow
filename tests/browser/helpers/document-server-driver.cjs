/* Thin window transport: document state and HTTP requests always use the actual service. */
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const readline = require('node:readline')
const { spawn } = require('node:child_process')

const root = path.resolve(__dirname, '../../..')
const serviceCommands = new Set(['start_document_server', 'document_server_status', 'read_shared_document', 'update_shared_document', 'stop_document_server'])

class DocumentServerDriver {
  constructor(binary, webDirectory) {
    this.pending = new Map(); this.sequence = 0; this.log = ''
    this.process = spawn(binary, [webDirectory], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    this.process.stderr.on('data', data => { this.log += data })
    readline.createInterface({ input: this.process.stdout }).on('line', line => {
      let reply
      try { reply = JSON.parse(line) } catch { this.log += line + '\n'; return }
      const request = this.pending.get(reply.id)
      if (!request) return
      this.pending.delete(reply.id); clearTimeout(request.timer)
      if (reply.error) request.reject(Error(reply.error)); else request.resolve(reply.result)
    })
    this.process.on('error', error => this.failPending(error))
    this.process.on('exit', (code, signal) => this.failPending(Error(`Document service driver exited (${code || signal}): ${this.log}`)))
  }
  failPending(error) { for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }; this.pending.clear() }
  invoke(command, args = {}) {
    assert.ok(serviceCommands.has(command), `Unsupported service command: ${command}`)
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`Service command timed out: ${command}\n${this.log}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer })
      this.process.stdin.write(JSON.stringify({ id, command, args }) + '\n')
    })
  }
  async close() {
    if (this.process.exitCode !== null) return
    this.process.stdin.end()
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.process.kill('SIGKILL'); resolve() }, 3000)
      this.process.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

async function installDesktopTransport(context, driver, directory) {
  const files = [], queuedOpen = [], calls = []
  await fs.mkdir(directory, { recursive: true })
  await context.exposeFunction('__documentServerInvoke', async (command, args = {}) => {
    calls.push({ command, args })
    if (serviceCommands.has(command)) return driver.invoke(command, args)
    if (command === 'plugin:event|listen') return 1
    if (command === 'plugin:event|unlisten' || command === 'close_native_window') return null
    if (command === 'open_native_files') return queuedOpen.splice(0)
    if (command === 'save_native_file') {
      const name = path.basename(args.request.suggestedName), bytes = Buffer.from(args.request.bytesBase64, 'base64')
      const filePath = path.join(directory, `${files.length}-${name}`)
      await fs.writeFile(filePath, bytes)
      const file = { name, path: filePath, bytes, stamp: `saved-${files.length}` }
      files.push(file)
      return { name, path: filePath, stamp: file.stamp }
    }
    throw Error(`Unexpected window command: ${command}`)
  })
  await context.addInitScript(() => {
    let callbackId = 0
    window.__TAURI_INTERNALS__ = {
      invoke: (command, args) => window.__documentServerInvoke(command, args),
      transformCallback: () => ++callbackId,
      unregisterCallback: () => {},
    }
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  })
  return { files, calls, queuedOpen }
}

module.exports = { DocumentServerDriver, installDesktopTransport, serviceCommands }
