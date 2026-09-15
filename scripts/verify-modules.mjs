// dsh-task-time 模块开关验证脚本
// 用真实 lib/client.js / lib/index.js + mock DSH 运行时，验证：
//  1) 模块配置未加载时不渲染任何组件（避免提前出现）
//  2) 关闭「内部通知（提醒卡）」后提醒卡组件不渲染
//  3) 只开提醒模块（任务用时全关）时，提醒卡渲染、任务面板/设置弹窗/Dock 条不渲染
//  4) 任务完成提醒（finish）能进入提醒队列并渲染出卡片
//  5) 决策提醒（needDecision）能渲染出红色常驻卡
//  6) 勾选开关后立即生效（不需要重启 / 重新 apply）
//  7) host 端 set-module-config 往返：只改传入的键，子开关不被清空
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8')

// ---------- 断言 ----------
let failures = 0
const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? 'PASS' : String(detail ?? 'FAIL') })
  if (!cond) failures++
}

// ---------- 最小 React mock（支持异步 effects + setState 重渲染） ----------
function makeReact() {
  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { __el: true, type, props: Object.assign({}, props || {}), children: children.flat(Infinity).filter((c) => c != null && c !== false) }
  }
  const hookState = { current: null, index: 0 }
  let renderDirty = false

  function useHookSlot(init) {
    const hooks = hookState.current
    const i = hookState.index++
    if (hooks.length <= i) hooks[i] = typeof init === 'function' ? init() : init
    return hooks[i]
  }

  // 异步渲染：跑组件 → 执行 effects → 等宏任务让 RPC 链落地 → 若 setState 则重渲染
  async function renderAsync(Component, props) {
    const hooks = []
    let out = null
    for (let pass = 0; pass < 25; pass++) {
      hookState.current = hooks
      hookState.index = 0
      renderDirty = false
      out = Component(props || {})
      for (const h of hooks) {
        if (h && h.__effectFn && !h.__ran) {
          h.__ran = true
          try {
            const cleanup = h.__effectFn()
            if (typeof cleanup === 'function') h.__cleanup = cleanup
          } catch (e) {}
        }
      }
      await new Promise((r) => setTimeout(r, 0))
      if (!renderDirty) break
    }
    hookState.current = null
    return out
  }

  // 持久实例：模拟 React 已挂载的组件。hooks 数组在多次渲染间保留，
  // 因此 useSyncExternalStore 注册的订阅回调能真正驱动重渲染（这才是"实时生效"的关键）。
  function createInstance(Component, props) {
    const hooks = []
    function renderOnce() {
      hookState.current = hooks
      hookState.index = 0
      renderDirty = false
      const out = Component(props || {})
      for (const h of hooks) {
        if (h && h.__effectFn && !h.__ran) {
          h.__ran = true
          try {
            const cleanup = h.__effectFn()
            if (typeof cleanup === 'function') h.__cleanup = cleanup
          } catch (e) {}
        }
      }
      hookState.current = null
      return out
    }
    return {
      render: renderOnce,                 // 首次渲染
      rerender: renderOnce,               // 收到 store 通知后重渲染
      // store 通知次数：>0 证明订阅链路真的通了
      notified: () => hooks.reduce((n, h) => n + ((h && h.__notified) || 0), 0),
      tree: () => { hookState.current = null; return renderOnce() },
    }
  }

  return {
    createElement,
    Fragment: 'Fragment',
    renderAsync,
    mount: createInstance,
    useState: function (init) {
      const slot = useHookSlot(() => ({ value: typeof init === 'function' ? init() : init }))
      return [slot.value, function (v) {
        const next = typeof v === 'function' ? v(slot.value) : v
        if (next !== slot.value) { slot.value = next; renderDirty = true }
      }]
    },
    useEffect: function (fn) {
      const slot = useHookSlot(() => ({}))
      slot.__effectFn = fn
    },
    useRef: function (init) {
      return useHookSlot(() => ({ current: init }))
    },
    useSyncExternalStore: function (subscribe, getSnapshot) {
      const slot = useHookSlot(() => ({}))
      if (!slot.__subscribed) {
        slot.__subscribed = true
        slot.__notified = 0
        try { slot.__unsub = subscribe(function () { slot.__notified++ }) } catch (e) {}
      }
      return getSnapshot()
    },
  }
}

// ---------- 构建一个隔离的客户端环境 ----------
function createEnv(opts) {
  const options = opts || {}
  const React = makeReact()
  const registrations = []
  const injected = []
  const rpcCalls = []
  const intervals = []
  const timeouts = []

  let moduleConfigResolve = null
  const moduleConfigPromise = new Promise((res) => { moduleConfigResolve = res })

  function fetchMock(url, init) {
    const body = JSON.parse(init.body)
    rpcCalls.push(body)
    const method = body.method
    let data = {}
    if (method === 'get-module-config') {
      if (options.moduleConfig === undefined) {
        // 永不返回：模拟配置加载中
        return moduleConfigPromise.then((mc) => ({ json: () => Promise.resolve({ ok: true, data: mc }) }))
      }
      data = options.moduleConfig
    } else if (method === 'set-module-config') {
      // 模拟 host：只合并传入的键，返回权威配置
      const patch = (body.args && body.args.config) || {}
      const merged = JSON.parse(JSON.stringify(options.moduleConfig || {}))
      for (const modKey of ['timing', 'alert']) {
        if (!patch[modKey]) continue
        if (typeof patch[modKey].enabled === 'boolean') merged[modKey].enabled = patch[modKey].enabled
        if (patch[modKey].children) Object.assign(merged[modKey].children, patch[modKey].children)
      }
      options.moduleConfig = merged
      data = { ok: true, config: merged }
    } else if (method === 'get-reminders') {
      const since = (body.args && body.args.since) || 0
      const fresh = (options.reminders || []).filter((r) => r.id > since)
      data = { reminders: fresh, maxId: fresh.length ? fresh[fresh.length - 1].id : since }
    } else if (method === 'get-pending-setup') {
      data = { pending: false, taskName: null, plannedMinutes: null, defaultPlannedMinutes: 60, reminderIntervalMinutes: 10 }
    } else if (method === 'get-status') {
      data = options.status || { active: true, configured: true, taskName: '测试任务', running: true, waitingDecision: false, elapsedMs: 60000, plannedMs: 600000, remindersFired: 1 }
    } else if (method === 'get-task-board') {
      data = { active: [], finished: [], file: null }
    } else if (method === 'get-external-status') {
      data = { available: true, diagnostic: 'idle', toastDiag: '' }
    } else if (method === 'get-config') {
      data = { reminderIntervalMinutes: 10, plannedMinutes: 45, toastAppId: 'ai.deepseek.dsh.desktop', externalWhen: 'unfocused' }
    }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, data }) })
  }

  const sessionsStore = { current: (opts && opts.currentSession) || 'sess-1', byId: {} }
  function setCurrentSession(sid) { sessionsStore.current = sid }
  const sessionsSvc = {
    list: { getSnapshot: () => sessionsStore },
    open: () => Promise.resolve(),
  }

  const slots = {
    inject: function (name, factory) {
      injected.push(name)
      try { factory() } catch (e) {}
      return function () {}
    },
    register: function (meta, Component) {
      const entry = Object.assign({}, meta, { Component })
      registrations.push(entry)
      return entry
    },
  }

  const documentMock = {
    title: 'DSH',
    head: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
    visibilityState: 'visible',
    hasFocus: () => true,
    addEventListener: () => {},
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
      addEventListener: () => {},
      focus: () => {},
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

  const loaded = sandbox.__loaded
  const mod = loaded.factory((name) => {
    if (name === 'react') return React
    return {}
  })

  const ctx = {
    sessions: sessionsSvc,
    slots,
    remote: { $on: () => {} },
    effect: (fn) => { try { const c = fn(); if (typeof c === 'function') c() } catch (e) {} return () => {} },
  }

  return {
    mod, ctx, React, registrations, injected, rpcCalls, intervals,
    resolveModuleConfig: (mc) => moduleConfigResolve(mc),
    getEntry: (id) => registrations.find((r) => r.id === id),
    renderEntry: async (id, props) => {
      const e = registrations.find((r) => r.id === id)
      if (!e) return { missing: true }
      return React.renderAsync(e.Component, props || {})
    },
    // 挂载一个真实持久实例（可被 store 订阅驱动重渲染）
    mountEntry: (id, props) => {
      const e = registrations.find((r) => r.id === id)
      if (!e) return null
      const inst = React.mount(e.Component, props || {})
      inst.first = inst.render()
      return inst
    },
    // 切换当前会话（用于验证决策卡在当前会话中隐藏的行为）
    setCurrentSession: (sid) => {
      sessionsStore.current = sid
    },
    // 触发已注册的 interval 回调（模拟定时器到期）
    fireIntervals: () => {
      for (const iv of intervals) {
        try { iv.fn() } catch (e) {}
      }
    },
    tick: () => new Promise((r) => setImmediate(r)),
  }
}

// ---------- 默认全开配置 ----------
function allOn() {
  return {
    timing: { enabled: true, children: { timer: true, planning: true, intervalReminder: true, taskBoard: true, dockStatus: true, orphanCleanup: true } },
    alert: { enabled: true, children: { decisionDetection: true, externalNotify: true, titleFlash: true, reminderUI: true, toastJump: true } },
  }
}

// ---------- 元素树工具 ----------
// 树里可能包含函数组件元素（如 ModuleToggle），需要先展开才能看到真实 DOM 结构。
function flattenText(n) {
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(flattenText).join('')
  if (n && n.__el) return (n.children || []).map(flattenText).join('')
  return ''
}
function expandTree(node, depth) {
  const d = depth || 0
  if (d > 20) return node
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => expandTree(n, d + 1)).filter((x) => x != null && x !== false)
  if (!node.__el) return node
  const kids = (node.children || []).map((n) => expandTree(n, d + 1)).filter((x) => x != null && x !== false)
  if (typeof node.type === 'function') {
    // 展开无 hooks 的展示型函数组件
    const props = Object.assign({}, node.props, { children: kids })
    let rendered
    try { rendered = node.type(props) } catch (e) { return { __el: true, type: 'unexpanded', props: node.props, children: kids } }
    return expandTree(rendered, d + 1)
  }
  return { __el: true, type: node.type, props: node.props, children: kids }
}
function collectToggles(node, out) {
  const acc = out || []
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((n) => collectToggles(n, acc)); return acc }
  if (node.__el) {
    if (node.type === 'div' && /tt-row/.test((node.props && node.props.className) || '')) {
      const labelEl = (node.children || []).find((c) => c && c.__el && c.type === 'label')
      if (labelEl) {
        const input = (labelEl.children || []).find((c) => c && c.__el && c.type === 'input' && c.props && c.props.type === 'checkbox')
        if (input) acc.push({ text: flattenText(labelEl).trim(), input })
      }
    }
    ;(node.children || []).forEach((c) => collectToggles(c, acc))
  }
  return acc
}
function collectTogglesDeep(tree) {
  return collectToggles(expandTree(tree))
}

// ================= 场景 1：配置未加载时不渲染 =================
{
  const env = createEnv({ moduleConfig: undefined }) // 配置永不返回
  env.mod.apply(env.ctx)
  await env.tick()

  check('未加载配置：提醒卡组件注册存在', !!env.getEntry('task-time-reminder'), 'entry missing')
  const out = await env.renderEntry('task-time-reminder')
  check('未加载配置：提醒卡不渲染（返回 null）', out === null, JSON.stringify(out))
}

// ================= 场景 2：内部通知（提醒卡）关闭时不渲染 =================
{
  const mc = allOn()
  mc.timing.enabled = false
  for (const k of Object.keys(mc.timing.children)) mc.timing.children[k] = false
  mc.alert.children.reminderUI = false
  mc.alert.children.externalNotify = true // 外部通知仍开（模拟「只有外部通知」的现象）

  const env = createEnv({
    moduleConfig: mc,
    reminders: [{ id: 1, kind: 'finish', sessionId: 'sess-1', taskName: '测试任务', text: '✅ 任务结束', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  const poll = env.intervals.find((i) => i.ms === 2000)
  if (poll) { poll.fn(); await env.tick(); await env.tick() }

  check('内部通知关闭：提醒卡不渲染（即使有提醒）', (await env.renderEntry('task-time-reminder')) === null, 'should be null')
}

// ================= 场景 3：只开提醒模块（任务用时全关） =================
{
  const mc = {
    timing: { enabled: false, children: { timer: false, planning: false, intervalReminder: false, taskBoard: false, dockStatus: false, orphanCleanup: false } },
    alert: { enabled: true, children: { decisionDetection: true, externalNotify: true, titleFlash: true, reminderUI: true, toastJump: true } },
  }
  const env = createEnv({
    moduleConfig: mc,
    reminders: [{ id: 1, kind: 'finish', sessionId: 'sess-1', taskName: '测试任务', text: '✅ 任务结束', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  const poll = env.intervals.find((i) => i.ms === 2000)
  if (poll) { poll.fn(); await env.tick(); await env.tick() }

  check('只开提醒：提醒卡渲染（非 null）', (await env.renderEntry('task-time-reminder')) !== null, 'should render')
  check('只开提醒：设置弹窗不渲染', (await env.renderEntry('task-time-setup')) === null, 'setup should be null')
  check('只开提醒：任务面板不渲染', (await env.renderEntry('task-time-board')) === null, 'board should be null')
  check('只开提醒：Dock 状态条不渲染', (await env.renderEntry('task-time-status', { sessionId: 'sess-1' })) === null, 'dock should be null')
  check('只开提醒：设置页仍注册（用于改开关）', !!env.getEntry('task-time'), 'settings missing')
}

// ================= 场景 4：任务完成提醒进入队列并渲染卡片 =================
{
  const mc = allOn()
  const hostReminders = [
    { id: 1, kind: 'finish', sessionId: 'sess-1', taskName: '测试任务', text: '✅ 任务结束：累计实际用时 12 分钟，计划 10 分钟，超出计划 2 分钟', ts: Date.now(), needDecision: false, autoMs: 4000 },
  ]
  const env = createEnv({ moduleConfig: mc, reminders: hostReminders })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  await env.tick()

  const poll = env.intervals.find((i) => i.ms === 2000)
  check('任务完成：存在 2s 主轮询', !!poll, 'poll missing')
  if (poll) { poll.fn(); await env.tick(); await env.tick() }

  const out = await env.renderEntry('task-time-reminder')
  const txt = JSON.stringify(out)
  check('任务完成：渲染出提醒卡', out !== null, 'card not rendered')
  check('任务完成：卡片文本含任务结束', /任务结束/.test(txt), txt.slice(0, 300))
  check('任务完成：卡片非红色常驻（needDecision=false）', !/tt-need-decision/.test(txt), txt.slice(0, 300))
}

// ================= 场景 5：决策提醒渲染红色常驻卡 =================
{
  const mc = allOn()
  const hostReminders = [
    { id: 7, kind: 'decision', sessionId: 'sess-decision', taskName: '测试任务', text: '需要你批准「pwsh」', ts: Date.now(), needDecision: true, autoMs: 0 },
  ]
  const env = createEnv({ moduleConfig: mc, reminders: hostReminders, currentSession: 'sess-other' })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  const poll = env.intervals.find((i) => i.ms === 2000)
  if (poll) { poll.fn(); await env.tick(); await env.tick() }
  const txt = JSON.stringify(await env.renderEntry('task-time-reminder'))
  check('决策提醒：渲染红色常驻卡', /tt-need-decision/.test(txt), txt.slice(0, 300))
  check('决策提醒：文案含「需要你决策」', /需要你决策/.test(txt), txt.slice(0, 300))
}

// ================= 场景 6：提醒模块整体关闭 =================
{
  const mc = allOn()
  mc.alert.enabled = false
  for (const k of Object.keys(mc.alert.children)) mc.alert.children[k] = false
  const env = createEnv({ moduleConfig: mc })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  check('提醒全关：提醒卡不渲染', (await env.renderEntry('task-time-reminder')) === null, 'should be null')
  check('提醒全关：任务面板仍渲染（任务用时未关）', (await env.renderEntry('task-time-board')) !== null, 'board should render')
  check('提醒全关：Dock 状态条仍渲染', (await env.renderEntry('task-time-status', { sessionId: 'sess-1' })) !== null, 'dock should render')
}

// ================= 场景 7：源码级回归（主开关不清空子开关 / 不丢弃点击） =================
{
  const clientSrc = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8')
  const hostSrc = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')

  check(
    '主开关：client 不再把子开关批量置 false',
    !/if \(!checked\) \{\s*for \(var k of Object\.keys\(next\[moduleKey\]\.children\)\) next\[moduleKey\]\.children\[k\] = false;/.test(clientSrc),
    'client 仍在批量置 false（主开关会清空子开关）'
  )
  check(
    '保存：不再因 saving 丢弃点击（无 if (saving) return）',
    !/function saveModuleConfig\(next\) \{\s*if \(saving\) return;/.test(clientSrc),
    '仍存在 if (saving) return 丢弃逻辑'
  )
  check('保存：使用串行队列（saveChain）', /saveChain/.test(clientSrc), '未使用串行保存队列')
  check(
    'host：主开关关闭不清空 children',
    !/enabled === false[\s\S]{0,200}children\[.*\]\s*=\s*false/.test(hostSrc),
    'host 仍在清空 children'
  )
}

// ================= 场景 8：Host 端模块开关 RPC 往返与子开关保留 =================
{
  const { mkdtempSync, writeFileSync: wf, readFileSync: rf, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { pathToFileURL } = await import('node:url')

  const work = mkdtempSync(join(tmpdir(), 'dsh-tt-mod-'))
  const stateFile = join(work, 'state.json')
  const modFile = join(work, 'modules.json')

  let hostSrc = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')
  hostSrc = hostSrc
    .replace(
      "const RECORDS_FILE = join(homedir(), '.dsh', 'dsh-task-time-records.json')",
      `const RECORDS_FILE = ${JSON.stringify(stateFile)}`
    )
    .replace(
      "const MODULE_CONFIG_FILE = join(homedir(), '.dsh', 'dsh-task-time-modules.json')",
      `const MODULE_CONFIG_FILE = ${JSON.stringify(modFile)}`
    )
    .replace(
      "const f = join(homedir(), '.dsh', 'dsh-task-time-records.json')",
      `const f = ${JSON.stringify(stateFile)}`
    )
    .replace(/const legacyCandidates = \[[\s\S]*?\]/, 'const legacyCandidates = []')

  const hostFile = join(work, 'index.mjs')
  wf(hostFile, hostSrc, 'utf8')

  const routes = []
  const events = {}
  const liveRoots = []
  const hostCtx = {
    get: (n) => (n === 'agents' ? { roots: () => liveRoots } : undefined),
    on: (n, fn) => { events[n] = fn; return () => {} },
    effect: (fn) => { const c = fn(); if (typeof c === 'function') c(); return () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    tools: { register: () => () => {} },
    systemPrompt: { section: () => () => {} },
  }

  function hostRpc(method, args) {
    return new Promise((resolve, reject) => {
      const route = routes[routes.length - 1]
      const body = Buffer.from(JSON.stringify({ method, args: args || {} }))
      const req = {
        on: (evt, cb) => {
          if (evt === 'data') setTimeout(() => cb(body), 0)
          if (evt === 'end') setTimeout(cb, 5)
        },
      }
      const chunks = []
      const res = { writeHead: () => {}, end: (b) => chunks.push(b) }
      route.handler(req, res).then(() => {
        const parsed = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'))
        if (parsed.ok) resolve(parsed.data)
        else reject(new Error(parsed.error))
      }).catch(reject)
    })
  }

  const host = await import(pathToFileURL(hostFile).href)
  host.apply(hostCtx)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 200))

  const mc0 = await hostRpc('get-module-config', {})
  check('host: 默认配置存在且全开', mc0 && mc0.timing.enabled === true && mc0.alert.children.reminderUI === true, JSON.stringify(mc0))

  // 只发 enabled=false（不带 children）→ 子开关必须保留
  const r1 = await hostRpc('set-module-config', { config: { timing: { enabled: false } } })
  check('host: 仅关主开关后子开关保留', r1.config.timing.children.timer === true && r1.config.timing.children.planning === true, JSON.stringify(r1.config.timing))

  // 主开关重新打开 → 子开关仍是 true
  const r2 = await hostRpc('set-module-config', { config: { timing: { enabled: true } } })
  check('host: 重开主开关后子开关仍为开', r2.config.timing.enabled === true && r2.config.timing.children.timer === true, JSON.stringify(r2.config.timing))

  // 单关一个子开关
  const r3 = await hostRpc('set-module-config', { config: { alert: { children: { reminderUI: false } } } })
  check('host: 单关子开关生效', r3.config.alert.children.reminderUI === false, JSON.stringify(r3.config.alert))
  check('host: 其它子开关不受影响', r3.config.alert.children.externalNotify === true && r3.config.alert.enabled === true, JSON.stringify(r3.config.alert))

  // 落盘确认持久化
  const onDisk = JSON.parse(rf(modFile, 'utf8'))
  check('host: 模块配置已落盘', onDisk.alert.children.reminderUI === false, JSON.stringify(onDisk))

  // 默认计划用时（任务用时模块里的可修改默认配置）host 侧贯通
  const cfg0 = await hostRpc('get-config', {})
  check('host: get-config 带默认计划用时', cfg0.plannedMinutes === 60, JSON.stringify(cfg0))
  const cfg1 = await hostRpc('set-config', { config: { plannedMinutes: 45, reminderIntervalMinutes: 12 } })
  check('host: set-config 可改默认计划用时', cfg1.plannedMinutes === 45 && cfg1.reminderIntervalMinutes === 12, JSON.stringify(cfg1))
  liveRoots.push({ id: 'cfg-new-sess' })
  const pend = await hostRpc('get-pending-setup', { sessionId: 'cfg-new-sess' })
  check('host: 设置弹窗下发默认计划用时', pend.pending === true && pend.defaultPlannedMinutes === 45, JSON.stringify(pend))

  try { rmSync(work, { recursive: true, force: true }) } catch (e) {}
}

// ================= 场景 9：设置页 = 模块开关 + 该模块最需要的配置 =================
{
  const mc = allOn()
  const env = createEnv({ moduleConfig: mc })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  const tree = await env.renderEntry('task-time')
  const txt = flattenText(expandTree(tree))

  check('设置页：标题为「模块开关与默认配置」', /模块开关与默认配置/.test(txt), txt.slice(0, 400))
  check('设置页：含「启用任务用时」主开关', /启用任务用时/.test(txt), txt.slice(0, 400))
  check('设置页：含「启用提醒」主开关', /启用提醒/.test(txt), txt.slice(0, 400))
  check('设置页：任务用时里含「默认计划用时」', /默认计划用时/.test(txt), txt.slice(0, 400))
  check('设置页：默认计划用时为预设下拉 + 自定义', /自定义/.test(txt) && /分钟/.test(txt), txt.slice(0, 400))
  check('设置页：任务用时里含「默认提醒间隔（分钟）」', /默认提醒间隔（分钟）/.test(txt), txt.slice(0, 400))
  check('设置页：保留「发送测试通知」按钮', /发送测试通知/.test(txt), txt.slice(0, 400))
  check('设置页：保留「通知应用身份（AUMID）」配置', /通知应用身份（AUMID）/.test(txt), txt.slice(0, 400))
  check(
    '设置页：提醒模块区分内部/外部通知',
    /内部通知/.test(txt) && /外部通知/.test(txt) && /提醒卡/.test(txt) && /系统\s*Toast/.test(txt),
    txt.slice(0, 500)
  )

  const clientSrc3 = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8')
  check('client：不再有 legacy 外部通知勾选框', !/cfg\.externalAlert/.test(clientSrc3), 'client 仍引用 cfg.externalAlert')
}

// ================= 场景 10：勾选开关后立即生效（不需要重启/重新 apply） =================
{
  const mc = {
    timing: { enabled: false, children: { timer: false, planning: false, intervalReminder: false, taskBoard: false, dockStatus: false, orphanCleanup: false } },
    alert: { enabled: true, children: { decisionDetection: true, externalNotify: true, titleFlash: true, reminderUI: true, toastJump: true } },
  }
  const env = createEnv({ moduleConfig: mc })
  env.mod.apply(env.ctx)   // 只 apply 一次
  await env.tick()
  await env.tick()

  check('实时开关：初始任务面板不渲染', (await env.renderEntry('task-time-board')) === null, 'board should be null initially')

  // 挂载一个持久实例，用来验证 store 订阅真的会驱动重渲染（而不是靠"重新渲染一次"蒙对）
  const boardInst = env.mountEntry('task-time-board')
  check('实时开关：任务面板已挂载', !!boardInst && boardInst.first === null, JSON.stringify(boardInst && boardInst.first))

  const toggles = collectTogglesDeep(await env.renderEntry('task-time'))
  const byText = (kw) => toggles.find((t) => t.text.indexOf(kw) !== -1)
  const master = byText('启用任务用时')
  const boardToggle = byText('任务面板')
  const dockToggle = byText('Dock 状态条')

  check('实时开关：设置页含「启用任务用时」开关', !!master, JSON.stringify(toggles.map((t) => t.text)))
  check('实时开关：设置页含「任务面板」子开关', !!boardToggle, JSON.stringify(toggles.map((t) => t.text)))
  check('实时开关：含「Dock 状态条」子开关', !!dockToggle, JSON.stringify(toggles.map((t) => t.text)))
  check('实时开关：主开关关闭时子开关置灰禁用', !!(boardToggle && boardToggle.input.props.disabled === true), JSON.stringify(boardToggle && boardToggle.input.props))

  if (master) {
    master.input.props.onChange({ target: { checked: true } })
    await env.tick()
    await env.tick()
  }
  // 主开关打开后重新取树（子开关从禁用变可用）。
  // 注意：真实 React 每次点击后都会重渲染，下一次点击拿到的是新闭包里的 mc；
  // 所以这里每次点击前都重新渲染一次，取最新的 onChange。
  async function clickToggle(keyword, checked) {
    const list = collectTogglesDeep(await env.renderEntry('task-time'))
    const t = list.find((x) => x.text.indexOf(keyword) !== -1)
    if (!t) return false
    t.input.props.onChange({ target: { checked } })
    await env.tick()
    await env.tick()
    return true
  }

  const masterOpened = await (async () => {
    const list = collectTogglesDeep(await env.renderEntry('task-time'))
    const m = list.find((x) => x.text.indexOf('启用任务用时') !== -1)
    if (!m) return false
    m.input.props.onChange({ target: { checked: true } })
    await env.tick()
    await env.tick()
    return true
  })()
  check('实时开关：主开关可点击打开', masterOpened, 'master toggle missing')

  const afterMaster = collectTogglesDeep(await env.renderEntry('task-time'))
  const boardAfter = afterMaster.find((t) => t.text.indexOf('任务面板') !== -1)
  check('实时开关：主开关打开后子开关不再禁用', !!(boardAfter && boardAfter.input.props.disabled !== true), JSON.stringify(boardAfter && boardAfter.input.props))

  const boardClicked = await clickToggle('任务面板', true)
  const dockClicked = await clickToggle('Dock 状态条', true)
  check('实时开关：任务面板开关可点击', boardClicked, 'board toggle missing')
  check('实时开关：Dock 状态条开关可点击', dockClicked, 'dock toggle missing')

  check('实时开关：勾选后任务面板立即渲染（无需重启）', (await env.renderEntry('task-time-board')) !== null, 'board did not appear')
  check('实时开关：勾选后 Dock 状态条立即渲染', (await env.renderEntry('task-time-status', { sessionId: 'sess-1' })) !== null, 'dock did not appear')

  // 关键：已挂载实例收到了 store 变更通知，并重渲染后立即出现
  check('实时开关：已挂载实例收到 store 通知（订阅链路通）', boardInst.notified() > 0, 'notified=' + boardInst.notified())
  check('实时开关：已挂载实例重渲染后任务面板出现', boardInst.rerender() !== null, 'mounted board still null after store change')

  // 再关掉 → 应立即消失
  const toggles3 = collectTogglesDeep(await env.renderEntry('task-time'))
  const boardToggle3 = toggles3.find((t) => t.text.indexOf('任务面板') !== -1)
  if (boardToggle3) {
    boardToggle3.input.props.onChange({ target: { checked: false } })
    await env.tick()
    await env.tick()
    check('实时开关：取消勾选后任务面板立即消失', (await env.renderEntry('task-time-board')) === null, 'board did not disappear')
  } else {
    check('实时开关：取消勾选后任务面板立即消失', false, '子开关未找到，无法验证')
  }

  const saveCalls = env.rpcCalls.filter((c) => c.method === 'set-module-config')
  check('实时开关：开关变更已发往 host（set-module-config）', saveCalls.length >= 2, 'set-module-config 调用数=' + saveCalls.length)
}

// ================= 场景 11：决策卡会话感知 — 在决策会话里自动隐藏，在其他会话里出现 =================
{
  const mc = allOn()
  // 当前会话是 sess-1，有一条对 sess-2 的决策提醒
  const env = createEnv({
    moduleConfig: mc,
    currentSession: 'sess-1',
    reminders: [
      { id: 10, kind: 'decision', sessionId: 'sess-2', taskName: '测试任务', text: '需要你决策', ts: Date.now(), needDecision: true, autoMs: 0 },
    ],
  })
  env.mod.apply(env.ctx)
  await env.tick()
  await env.tick()
  // 触发主轮询拉取 host 提醒 → pushReminder 写入本地 store
  const poll = env.intervals.find((i) => i.ms === 2000)
  if (poll) { poll.fn(); await env.tick(); await env.tick() }

  // 当前在 sess-1，决策会话是 sess-2 → 应该显示卡片
  const cardOther = await env.renderEntry('task-time-reminder')
  check('决策卡：不在决策会话时渲染卡片', cardOther !== null && !/missing/.test(JSON.stringify(cardOther)), 'card should show for other session decision: ' + JSON.stringify(cardOther).slice(0, 200))

  // 挂载持久实例 + 切换到 sess-2（决策发生的会话）
  const inst = env.mountEntry('task-time-reminder')
  check('决策卡：挂载后初始显示（sess-1 不在 sess-2）', inst.first !== null && !/missing/.test(JSON.stringify(inst.first)), 'should show initially: ' + JSON.stringify(inst.first).slice(0, 200))
  env.setCurrentSession('sess-2')
  env.fireIntervals()          // 触发 ReminderStack 的 1.5s 会话检测
  const treeAfterSwitch = inst.rerender()
  check('决策卡：切到决策会话后卡片仍显示（DOM 渲染不过滤会话）', treeAfterSwitch !== null, 'card should stay visible: ' + JSON.stringify(treeAfterSwitch).slice(0, 200))

  // 切回 sess-1 → 卡片应重新出现
  env.setCurrentSession('sess-1')
  env.fireIntervals()
  const treeBack = inst.rerender()
  check('决策卡：切回非决策会话后卡片出现', treeBack !== null, 'card should reappear')

  // 当前会话就是决策会话 → 初始不显示卡片
  const env2 = createEnv({
    moduleConfig: mc,
    currentSession: 'sess-1',
    reminders: [
      { id: 11, kind: 'decision', sessionId: 'sess-1', taskName: '当前任务', text: '需要你批准', ts: Date.now(), needDecision: true, autoMs: 0 },
    ],
  })
  env2.mod.apply(env2.ctx)
  await env2.tick()
  await env2.tick()
  const poll2 = env2.intervals.find((i) => i.ms === 2000)
  if (poll2) { poll2.fn(); await env2.tick(); await env2.tick() }
  const cardSame = await env2.renderEntry('task-time-reminder')
  check('决策卡：在决策会话时仍显示卡片（DOM 渲染不过滤会话）', cardSame !== null, 'card should be visible for same session: ' + JSON.stringify(cardSame).slice(0, 200))
}

// ---------- 输出 ----------
console.log('=== dsh-task-time 模块开关验证结果 ===')
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  →  ' + r.detail}`)
}
console.log(failures === 0 ? '全部通过' : `失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
