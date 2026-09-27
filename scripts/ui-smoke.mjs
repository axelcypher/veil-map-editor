import { spawn } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const profile = await mkdtemp(join(tmpdir(), 'veil-edge-'))
const port = 9333
const browser = spawn(edge, [
  '--headless=new', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--window-size=1280,820', 'http://localhost:5173/',
], { stdio: 'ignore' })

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
let page
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const targets = await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())
    page = targets.find(target => target.type === 'page' && target.url.includes('localhost:5173'))
    if (page) break
  } catch { /* browser is still starting */ }
  await wait(100)
}
if (!page) throw new Error('Could not connect to Edge DevTools')

const socket = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
let commandId = 0
const pending = new Map()
socket.onmessage = event => {
  const response = JSON.parse(event.data)
  const handler = pending.get(response.id)
  if (!handler) return
  pending.delete(response.id)
  response.error ? handler.reject(new Error(response.error.message)) : handler.resolve(response.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++commandId
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value

await send('Page.enable')
await wait(1200)
const state = await evaluate(`(() => {
  // needs the dev server: the app exposes its cell graph and heights as window.__veil there
  const { graph, view } = window.__veil;
  const rect = document.querySelector('#ui-canvas').getBoundingClientRect();
  const x = rect.left + view.x + graph.width / 2 * view.scale;
  const y = rect.top + view.y + graph.height / 2 * view.scale;
  const distance = i => (graph.x[i] - graph.width / 2) ** 2 + (graph.y[i] - graph.height / 2) ** 2;
  let cell = 0;
  for (let i = 1; i < graph.cellCount; i += 1) if (distance(i) < distance(cell)) cell = i;
  const strength = document.querySelector('#brush-strength');
  strength.value = '2500'; strength.dispatchEvent(new Event('input'));
  window.__veilSmoke = { height: () => Math.round(window.__veil.elevations[cell]) };
  return { x, y, before: window.__veilSmoke.height(), cells: document.querySelector('#mesh-info').textContent };
})()`)

await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: state.x, y: state.y, button: 'left', buttons: 1, clickCount: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: state.x + 80, y: state.y, button: 'left', buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: state.x + 80, y: state.y, button: 'left', buttons: 0, clickCount: 1 })
await wait(400)
const after = await evaluate('window.__veilSmoke.height()')
await evaluate("document.querySelector('#undo').click()")
await wait(300)
const afterUndo = await evaluate('window.__veilSmoke.height()')
const screenshot = await send('Page.captureScreenshot', { format: 'png' })
const screenshotPath = join(tmpdir(), 'veil-height-editor-smoke.png')
await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'))
await send('Browser.close')
await new Promise(resolve => browser.once('exit', resolve))

const changed = state.before !== after
const restored = state.before === afterUndo
console.log(JSON.stringify({ cells: state.cells, changed, restored, before: state.before, after, afterUndo, screenshotPath }, null, 2))
if (!changed || !restored) process.exitCode = 1
