// dsh-task-time —— 「内部通知 / 外部通知」两条通道验证
//
// 需求：人在 DSH 里就不该再弹系统通知，只走内部通知（提醒卡 + 提示音）；
//       只有人不在 DSH（切走 / 最小化 / 关掉页面）时才需要外部通知（系统 Toast）。
//
// 验证点：
//  1) client 每 2 秒上报 ui-presence（焦点 + 可见性），host 据此判定 inFront
//  2) inFront 的判定规则随「外部通知时机」配置变化（unfocused / hidden）
//  3) 人在 DSH 里（inFront=true）→ 提醒到达时响内部提示音，且不发系统通知
//  4) 人不在 DSH（inFront=false）→ 不响提示音（交给外部通知）
//  5) host 侧所有系统通知调用点都被 shouldSendExternal() 守住；测试按钮不受限制
//  6) 配置持久化（externalWhen）
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8')
const HOST_SRC = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')

let failures = 0
const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? 'PASS' : String(detail ?? 'FAIL') })
  if (!cond) failures++
}

// =====================================================================
// 一、host：inFront 判定 + 外部通知门控
// =====================================================================
{
  const work = mkdtempSync(join(tmpdir(), 'dsh-tt-chan-'))
  const stateFile = join(work, 'state.json')
  const modFile = join(work, 'modules.json')
  const legacy = join(work, 'legacy.json')

  const hostSrc = HOST_SRC
    .replace("const RECORDS_FILE = join(homedir(), '.dsh', 'dsh-task-time-records.json')", `const RECORDS_FILE = ${JSON.stringify(stateFile)}`)
    .replace("const MODULE_CONFIG_FILE = join(homedir(), '.dsh', 'dsh-task-time-modules.json')", `const MODULE_CONFIG_FILE = ${JSON.stringify(modFile)}`)
    .replace("const f = join(homedir(), '.dsh', 'dsh-task-time-records.json')", `const f = ${JSON.stringify(stateFile)}`)
    .replace(/const legacyCandidates = \[[\s\S]*?\]/, `const legacyCandidates = [${JSON.stringify(legacy)}]`)

  writeFileSync(stateFile, JSON.stringify({ records: [], defaults: {}, configs: {}, dismissed: [], tasks: {}, history: {} }), 'utf8')

  const routes = []
  const events = {}
  async function loadHost(name) {
    const file = join(work, name)
    writeFileSync(file, hostSrc, 'utf8')
    const handlerRoutes = []
    const ctx = {
      get: (n) => (n === 'agents' ? { roots: () => [] } : undefined),
      on: (n, fn) => { events[n] = fn; return () => {} },
      // 注意：effect 的返回值是「停用回调」，不能在 apply 时立刻调用（那会在状态恢复前就落盘）
      effect: (fn) => { try { fn() } catch (e) {} return () => {} },
      webServer: { register: (r) => { handlerRoutes.push(r); routes.push(r); return () => {} } },
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    }
    const mod = await import(pathToFileURL(file).href)
    mod.apply(ctx)
    await new Promise((r) => setTimeout(r, 250))
    return { mod, rpc: (method, args) => rpcOn(handlerRoutes, method, args) }
  }

  function rpcOn(routeList, method, args) {
    return new Promise((resolve, reject) => {
      const route = routeList[routeList.length - 1]
      const body = Buffer.from(JSON.stringify({ method, args: args || {} }))
      const req = { on: (evt, cb) => { if (evt === 'data') setTimeout(() => cb(body), 0); if (evt === 'end') setTimeout(cb, 5) } }
      const chunks = []
      const res = { writeHead: () => {}, end: (b) => chunks.push(b) }
      route.handler(req, res).then(() => {
        const parsed = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'))
        if (parsed.ok) resolve(parsed.data)
        else reject(new Error(parsed.error))
      }).catch(reject)
    })
  }

  const h = await loadHost('host1.mjs')

  const cfg0 = await h.rpc('get-config', {})
  check('host：默认「外部通知时机」= DSH 不在前台时', cfg0.externalWhen === 'unfocused', JSON.stringify(cfg0))

  // 没有任何上报（页面还没开 / 渲染进程没起来）→ 视为不在 DSH → 该发外部通知
  const st0 = await h.rpc('get-external-status', {})
  check('host：未收到上报时视为不在 DSH（外部通知可用）', st0.inFront === false, JSON.stringify(st0))

  // 人在 DSH：页面可见 + 窗口在前台
  await h.rpc('ui-presence', { focused: true, visible: true })
  const st1 = await h.rpc('get-external-status', {})
  check('host：页面可见且前台 → inFront=true（不发系统通知）', st1.inFront === true, JSON.stringify(st1))

  // 切到别的窗口（页面还看得见）→ 默认判定为“不在 DSH”
  const p2 = await h.rpc('ui-presence', { focused: false, visible: true })
  check('host：ui-presence 直接返回 inFront 供 client 对齐', p2.inFront === false, JSON.stringify(p2))
  const st2 = await h.rpc('get-external-status', {})
  check('host：unfocused 模式下失焦即算离开 DSH', st2.inFront === false, JSON.stringify(st2))

  // 切到「只有页面不可见才算离开」
  const cfgHidden = await h.rpc('set-config', { config: { externalWhen: 'hidden' } })
  check('host：可切换到「只有页面不可见时」', cfgHidden.externalWhen === 'hidden', JSON.stringify(cfgHidden))
  const st3 = await h.rpc('get-external-status', {})
  check('host：hidden 模式下页面可见（哪怕失焦）仍算在 DSH', st3.inFront === true, JSON.stringify(st3))

  await h.rpc('ui-presence', { focused: false, visible: false })
  const st4 = await h.rpc('get-external-status', {})
  check('host：hidden 模式下页面不可见 → 不在 DSH（发系统通知）', st4.inFront === false, JSON.stringify(st4))

  // 重启后配置仍在（host 落盘是 800ms 防抖，等一下）
  await new Promise((r) => setTimeout(r, 1100))
  const onDisk = JSON.parse(readFileSync(stateFile, 'utf8'))
  const h2 = await loadHost('host2.mjs')
  const cfgAfter = await h2.rpc('get-config', {})
  check('host：externalWhen 持久化（重启后仍是 hidden）', cfgAfter.externalWhen === 'hidden', JSON.stringify(cfgAfter))
  check('host：设置页读到的默认值来自落盘文件（不是内置默认）', cfgAfter.plannedMinutes === 60, JSON.stringify(cfgAfter))

  // 源码级：所有系统通知调用点都必须过 shouldSendExternal()；测试按钮必须不受限制
  const sites = HOST_SRC.match(/externalAlert\(/g) || []
  const guarded = (HOST_SRC.match(/if \(shouldSendExternal\(\)\) \{/g) || []).length
  check(
    'host：4 个正式提醒点 + 1 个测试点 + 1 个函数定义（调用点数量符合预期）',
    sites.length === 6 && guarded === 4,
    'externalAlert( ' + sites.length + ' 次，shouldSendExternal 门控 ' + guarded + ' 处'
  )
  check(
    'host：不再有裸露的 externalNotify 直判（必须过 inFront）',
    !/if \(isModuleOn\('alert', 'externalNotify'\)\)/.test(HOST_SRC),
    '仍存在 isModuleOn 直判'
  )
  const testToastBody = HOST_SRC
    .slice(HOST_SRC.indexOf("'test-toast'"), HOST_SRC.indexOf("'test-toast'") + 900)
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  check('host：测试通知按钮不受时机限制（随时可发）', !/shouldSendExternal/.test(testToastBody), testToastBody.slice(0, 200))

  try { rmSync(work, { recursive: true, force: true }) } catch (e) {}
}

// =====================================================================
// 二、client：内部提示音只在「人在 DSH」时响
// =====================================================================
function makeReact() {
  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { __el: true, type, props: Object.assign({}, props || {}), children: children.flat(Infinity).filter((c) => c != null && c !== false) }
  }
  const hookState = { current: null, index: 0 }
  let renderDirty = false
  async function renderAsync(Component, props) {
    const hooks = []
    let out = null
    for (let pass = 0; pass < 6; pass++) {
      hookState.current = hooks
      hookState.index = 0
      renderDirty = false
      out = Component(props || {})
      for (const h of hooks) {
        if (h && h.__effectFn && !h.__ran) {
          h.__ran = true
          try { const cleanup = h.__effectFn(); if (typeof cleanup === 'function') h.__cleanup = cleanup } catch (e) {}
        }
      }
      await new Promise((r) => setImmediate(r))
      if (!renderDirty) break
    }
    hookState.current = null
    return out
  }
  return {
    createElement,
    Fragment: 'Fragment',
    renderAsync,
    useState: function (init) {
      const i = hookState.index++
      const hooks = hookState.current
      if (hooks.length <= i) hooks[i] = { value: typeof init === 'function' ? init() : init }
      const slot = hooks[i]
      return [slot.value, function (v) {
        const next = typeof v === 'function' ? v(slot.value) : v
        if (next !== slot.value) { slot.value = next; renderDirty = true }
      }]
    },
    useEffect: function (fn) {
      const i = hookState.index++
      const hooks = hookState.current
      if (hooks.length <= i) hooks[i] = {}
      hooks[i].__effectFn = fn
    },
    useRef: function (init) {
      const i = hookState.index++
      const hooks = hookState.current
      if (hooks.length <= i) hooks[i] = { current: init }
      return hooks[i]
    },
    useSyncExternalStore: function (subscribe, getSnapshot) {
      hookState.index++
      try { subscribe(function () {}) } catch (e) {}
      return getSnapshot()
    },
  }
}

// 假的 WebAudio：记录每次提示音的音符，用来断言「内部通知有没有响」
function makeFakeAudio() {
  const notes = []
  let ctxCount = 0
  function AudioContextMock() {
    ctxCount++
    this.state = 'running'
    this.currentTime = 0
    this.destination = {}
    this.resume = () => Promise.resolve()
    this.createOscillator = () => ({
      type: 'sine',
      frequency: { value: 0 },
      connect: () => {},
      start: () => { notes.push({ at: this.currentTime }) },
      stop: () => {},
    })
    this.createGain = () => ({
      gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: (v) => { notes[notes.length - 1] && (notes[notes.length - 1].gain = v) } },
      connect: () => {},
    })
  }
  return { AudioContextMock, notes, ctxCount: () => ctxCount }
}

function createClientEnv(opts) {
  const options = opts || {}
  const React = makeReact()
  const audio = makeFakeAudio()
  const registrations = []
  const intervals = []
  const timeouts = []
  const rpcCalls = []
  // 可变：host 对 ui-presence 的判定结果
  let inFrontResponse = !!options.inFront
  const reminders = options.reminders || []

  function fetchMock(url, init) {
    const body = JSON.parse(init.body)
    rpcCalls.push(body)
    const method = body.method
    let data = {}
    if (method === 'ui-presence') {
      data = { ok: true, inFront: inFrontResponse }
    } else if (method === 'get-reminders') {
      const since = (body.args && body.args.since) || 0
      const fresh = reminders.filter((r) => r.id > since)
      data = { reminders: fresh, maxId: fresh.length ? fresh[fresh.length - 1].id : since }
    } else if (method === 'get-module-config') {
      data = options.moduleConfig
    } else if (method === 'get-external-status') {
      data = { available: true, toastDiag: '', inFront: inFrontResponse, externalWhen: 'unfocused' }
    } else if (method === 'get-config') {
      data = { reminderIntervalMinutes: 10, plannedMinutes: 60, toastAppId: 'ai.deepseek.dsh.desktop', externalWhen: 'unfocused' }
    } else if (method === 'get-status') {
      data = { active: false, configured: true }
    } else if (method === 'get-task-board') {
      data = { active: [], finished: [] }
    } else if (method === 'get-pending-jump') {
      data = { sessionId: null }
    } else if (method === 'get-pending-setup') {
      data = { pending: false }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, data }) })
  }

  const sessionsStore = { current: 'sess-1', byId: {} }
  const slots = {
    inject: function (name, factory) { try { factory() } catch (e) {} return function () {} },
    register: function (meta, Component) { const e = Object.assign({}, meta, { Component }); registrations.push(e); return e },
  }
  const listeners = {}
  const documentMock = {
    title: 'DSH',
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    visibilityState: options.visible === false ? 'hidden' : 'visible',
    hasFocus: () => options.focused !== false,
    addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn) },
    getElementById: () => null,
    createElement: () => ({ set id(v) {}, set textContent(v) {}, style: {} }),
  }
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    React,
    fetch: fetchMock,
    document: documentMock,
    window: {
      __ModuleLoader__: { load: (m) => { sandbox.__loaded = m } },
      addEventListener: (t, fn) => { (listeners['win:' + t] = listeners['win:' + t] || []).push(fn) },
      focus: () => {},
      AudioContext: audio.AudioContextMock,
      Notification: undefined,
    },
    setTimeout: function (fn, ms) { timeouts.push({ fn, ms }); return timeouts.length },
    clearTimeout: () => {},
    setInterval: function (fn, ms) { intervals.push({ fn, ms }); return intervals.length },
    clearInterval: () => {},
    Notification: undefined,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Set, Map, Error, isFinite, parseInt, parseFloat,
  }
  sandbox.window.document = documentMock
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SRC, sandbox)
  const mod = sandbox.__loaded.factory((name) => (name === 'react' ? React : {}))

  const ctx = {
    sessions: { list: { getSnapshot: () => sessionsStore }, open: () => Promise.resolve() },
    slots,
    remote: { $on: () => {} },
    effect: (fn) => { try { const c = fn(); if (typeof c === 'function') c() } catch (e) {} return () => {} },
  }
  return {
    mod, ctx, React, registrations, intervals, rpcCalls, audio, listeners,
    setInFront: (v) => { inFrontResponse = !!v },
    getEntry: (id) => registrations.find((r) => r.id === id),
    renderEntry: (id, props) => {
      const e = registrations.find((r) => r.id === id)
      if (!e) return Promise.resolve({ missing: true })
      return React.renderAsync(e.Component, props || {})
    },
    tick: async (n) => { for (let i = 0; i < (n || 3); i++) await new Promise((r) => setImmediate(r)) },
  }
}

function allOn() {
  return {
    timing: { enabled: true, children: { timer: true, planning: true, intervalReminder: true, taskBoard: true, dockStatus: true, orphanCleanup: true } },
    alert: { enabled: true, children: { decisionDetection: true, externalNotify: true, titleFlash: true, reminderUI: true, toastJump: true } },
  }
}

async function runReminderArrival(inFront, modLabel) {
  const env = createClientEnv({
    moduleConfig: allOn(),
    inFront: inFront,
    focused: inFront,
    visible: true,
    reminders: [
      { id: 1, kind: 'interval', sessionId: 'sess-1', taskName: '测试任务', text: '🔔 第 1 次提醒', ts: Date.now(), needDecision: false, autoMs: 4000 },
    ],
  })
  env.mod.apply(env.ctx)
  await env.tick(4)
  const poll = env.intervals.find((i) => i.ms === 2000)
  check(modLabel + '：存在 2 秒主轮询', !!poll, 'poll missing')
  if (poll) { poll.fn(); await env.tick(4) }
  return env
}

// 人在 DSH 里 → 响内部提示音
{
  const env = await runReminderArrival(true, '在 DSH 里')
  check('在 DSH 里：提醒到达时响内部提示音（WebAudio 发声）', env.audio.notes.length > 0, 'notes=' + env.audio.notes.length)
  check('在 DSH 里：确实上报了 ui-presence', env.rpcCalls.some((c) => c.method === 'ui-presence'), JSON.stringify(env.rpcCalls.map((c) => c.method)))
}

// 人不在 DSH → 不响内部提示音（由 host 发系统通知）
{
  const env = await runReminderArrival(false, '不在 DSH')
  check('不在 DSH：不响内部提示音（交给外部通知）', env.audio.notes.length === 0, 'notes=' + env.audio.notes.length)
}

// 内部通知开关关掉 → 即使人在 DSH 也不响
{
  const mc = allOn()
  mc.alert.children.reminderUI = false
  const env = createClientEnv({
    moduleConfig: mc,
    inFront: true,
    reminders: [{ id: 1, kind: 'interval', sessionId: 'sess-1', taskName: '测试任务', text: '🔔', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env.mod.apply(env.ctx)
  await env.tick(4)
  const poll = env.intervals.find((i) => i.ms === 2000)
  if (poll) { poll.fn(); await env.tick(4) }
  check('内部通知开关关闭：不响提示音', env.audio.notes.length === 0, 'notes=' + env.audio.notes.length)
}

// 设置页文案与选项
{
  const env = createClientEnv({ moduleConfig: allOn(), inFront: true })
  env.mod.apply(env.ctx)
  await env.tick(4)
  const txt = JSON.stringify(await env.renderEntry('task-time'))
  check('设置页：提醒模块里有「内部通知（在 DSH 里…）」开关', /内部通知（在 DSH 里/.test(txt), txt.slice(0, 300))
  check('设置页：提醒模块里有「外部通知（不在 DSH 里…）」开关', /外部通知（不在 DSH 里/.test(txt), txt.slice(0, 300))
  check('设置页：有「外部通知时机」选择', /外部通知时机/.test(txt) && /DSH 不在前台时/.test(txt) && /只有 DSH 页面不可见时/.test(txt), txt.slice(0, 300))
  check('设置页：显示当前在不在 DSH', /当前状态/.test(txt) && /在 DSH 里 → 只发内部通知/.test(txt), txt.slice(0, 300))
  check('设置页：保留发送测试通知按钮', /发送测试通知/.test(txt), txt.slice(0, 300))
}

// 源码级：浏览器通知也归外部通道（人在 DSH 里不发）
{
  const body = CLIENT_SRC.slice(CLIENT_SRC.indexOf('function sendBrowserNotif'), CLIENT_SRC.indexOf('function sendBrowserNotif') + 500)
  check('client：浏览器通知要求外部通知开关', /isModuleOn\('alert', 'externalNotify'\)/.test(body), body.slice(0, 200))
  check('client：人在 DSH 里不发浏览器通知', /if \(inFront\) return;/.test(body), body.slice(0, 200))
}

// ---------- 输出 ----------
console.log('=== dsh-task-time 内部/外部通知通道验证结果 ===')
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  →  ' + r.detail}`)
}
console.log(failures === 0 ? '全部通过' : `失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
