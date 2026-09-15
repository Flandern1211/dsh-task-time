// dsh-task-time 客户端 UI 行为验证（可交互 DOM + mock React + 真实 lib/client.js）
//
// 与 verify-modules.mjs 的区别：
//  1) 提供一个**真的能创建/删除节点**的 DOM：verify-modules 的 document.getElementById 恒为 null、
//     也没有 document.body，所以 pushReminder() 里「直接用 DOM 渲染决策卡」那条路径从来没被跑到
//  2) 因此这里可以验证：决策卡是否重复渲染、× 能否真正关掉、决策处理后是否收场、
//     模块开关是否管得住提醒卡、远程 approval 事件与 host 轮询是否各自弹一张、提示音开关
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLIENT_SRC = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8')

let failures = 0
const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? 'PASS' : String(detail ?? 'FAIL') })
  if (!cond) failures++
}

// ---------- mock React（沿用 verify-modules.mjs 的实现，补上 effect deps 语义） ----------
let renderFunctionType = null
function makeReact() {
  function createElement(type, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return { __el: true, type, props: Object.assign({}, props || {}), children: children.flat(Infinity).filter((c) => c != null && c !== false) }
  }
  const hookState = { current: null, index: 0, prevCount: null }
  let renderDirty = false
  function useHookSlot(init) {
    const hooks = hookState.current
    if (!hooks) throw new Error('mock React: hook 在组件函数之外被调用')
    const i = hookState.index++
    if (hookState.prevCount !== null && i >= hookState.prevCount) {
      throw new Error('mock React #310: 本次渲染 hook 数多于上次')
    }
    if (hooks.length <= i) hooks[i] = typeof init === 'function' ? init() : init
    return hooks[i]
  }
  renderFunctionType = function (type, props) {
    const saved = { c: hookState.current, i: hookState.index, p: hookState.prevCount }
    hookState.current = []; hookState.index = 0; hookState.prevCount = null
    try { return type(props) } finally { hookState.current = saved.c; hookState.index = saved.i; hookState.prevCount = saved.p }
  }
  function runEffects(hooks) {
    for (const h of hooks) {
      if (!h || !h.__effectFn) continue
      const deps = h.__deps
      let shouldRun = !h.__ran
      if (!shouldRun && deps !== undefined && deps !== null) {
        const prev = h.__prevDeps
        shouldRun = !prev || prev.length !== deps.length || deps.some((d, i) => d !== prev[i])
      }
      if (!shouldRun) continue
      if (h.__cleanup) { try { h.__cleanup() } catch (e) {} }
      h.__ran = true
      h.__prevDeps = deps ? deps.slice() : null
      try { const c = h.__effectFn(); if (typeof c === 'function') h.__cleanup = c } catch (e) {}
    }
  }
  async function renderAsync(Component, props) {
    const hooks = []
    let out = null
    let prevCount = null
    for (let pass = 0; pass < 25; pass++) {
      hookState.current = hooks; hookState.index = 0; hookState.prevCount = prevCount
      renderDirty = false
      out = Component(props || {})
      prevCount = hookState.index
      runEffects(hooks)
      await new Promise((r) => setTimeout(r, 0))
      if (!renderDirty) break
    }
    hookState.current = null
    return out
  }
  function createInstance(Component, props) {
    const hooks = []
    let prevCount = null
    function renderOnce() {
      hookState.current = hooks; hookState.index = 0; hookState.prevCount = prevCount
      renderDirty = false
      const out = Component(props || {})
      prevCount = hookState.index
      runEffects(hooks)
      hookState.current = null
      return out
    }
    return {
      render: renderOnce,
      rerender: renderOnce,
      cleanup: () => { for (const h of hooks) { if (h && h.__cleanup) { try { h.__cleanup() } catch (e) {} } } },
    }
  }
  return {
    createElement, Fragment: 'Fragment', renderAsync, mount: createInstance,
    useState: function (init) {
      const slot = useHookSlot(() => ({ value: typeof init === 'function' ? init() : init }))
      return [slot.value, function (v) {
        const next = typeof v === 'function' ? v(slot.value) : v
        if (next !== slot.value) { slot.value = next; renderDirty = true }
      }]
    },
    useEffect: function (fn, deps) { const slot = useHookSlot(() => ({})); slot.__effectFn = fn; slot.__deps = deps },
    useRef: function (init) { return useHookSlot(() => ({ current: init })) },
    useSyncExternalStore: function (subscribe, getSnapshot) {
      const slot = useHookSlot(() => ({}))
      if (!slot.__subscribed) { slot.__subscribed = true; try { slot.__unsub = subscribe(function () {}) } catch (e) {} }
      return getSnapshot()
    },
  }
}

// ---------- 可交互 DOM ----------
function makeDom() {
  const byId = new Map()
  const all = []
  function makeNode(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      children: [],
      parentNode: null,
      attributes: {},
      style: {},
      className: '',
      textContent: '',
      title: '',
      onclick: null,
      _cssText: '',
      appendChild(c) {
        c.parentNode = node
        node.children.push(c)
        if (c && typeof c.id === 'string' && c.id) byId.set(c.id, c)
        return c
      },
      removeChild(c) {
        const i = node.children.indexOf(c)
        if (i >= 0) node.children.splice(i, 1)
        if (c) c.parentNode = null
        return c
      },
      setAttribute(k, v) { node.attributes[k] = String(v) },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(node.attributes, k) ? node.attributes[k] : null },
      querySelectorAll(sel) {
        const s = String(sel)
        const attr = /^\[(.+)\]$/.exec(s)
        const clsSel = /^\.([\w-]+)$/.exec(s)
        const hits = []
        ;(function walk(n) {
          for (const c of n.children) {
            if (attr && c.getAttribute && c.getAttribute(attr[1]) !== null) hits.push(c)
            else if (clsSel && typeof c.className === 'string' && c.className.split(/\s+/).indexOf(clsSel[1]) >= 0) hits.push(c)
            walk(c)
          }
        })(node)
        return hits
      },
      get id() { return node._id || '' },
      set id(v) { node._id = v; if (v) byId.set(v, node) },
      get cssText() { return node._cssText },
      set cssText(v) { node._cssText = v },
    }
    all.push(node)
    return node
  }
  const head = makeNode('head')
  const body = makeNode('body')
  const documentElement = makeNode('html')
  const documentMock = {
    title: 'DSH',
    head, body, documentElement,
    visibilityState: 'visible',
    hasFocus: () => pendingFocus,
    _listeners: {},
    addEventListener(evt, fn) { (documentMock._listeners[evt] = documentMock._listeners[evt] || []).push(fn) },
    createElement: (tag) => makeNode(tag),
    getElementById: (id) => byId.get(id) || null,
    _fire(evt) { for (const fn of documentMock._listeners[evt] || []) fn() },
  }
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  function cards() {
    const c = byId.get('__tt_cards')
    return c ? c.children.slice() : []
  }
  return {
    document: documentMock,
    nodes: all,
    cards,
    countCards: () => cards().length,
    cardInfo: () => cards().map((c) => ({ session: c.getAttribute('data-tt-session'), id: c.getAttribute('data-tt-id'), className: c.className })),
    clickCard(i) { const c = cards()[i]; if (c && c.onclick) c.onclick({ target: { className: 'tt-reminder' } }) },
    clickCardClose(i) {
      const c = cards()[i]
      if (!c) return false
      const close = c.querySelectorAll('.tt-close')[0]
      if (close && close.onclick) { close.onclick({ stopPropagation() {} }); return true }
      return false
    },
  }
}

// ---------- 可交互调度器 ----------
function makeScheduler() {
  const timeouts = new Map()
  const intervals = []
  let seq = 0
  return {
    timeouts, intervals,
    setTimeout(fn, ms) { const id = ++seq; timeouts.set(id, { fn, ms, cancelled: false }); return id },
    clearTimeout(id) { const t = timeouts.get(id); if (t) t.cancelled = true },
    setInterval(fn, ms) { const id = ++seq; intervals.push({ id, fn, ms }); return id },
    clearInterval(id) { const i = intervals.findIndex((x) => x.id === id); if (i >= 0) intervals.splice(i, 1) },
    fireMs(ms) {
      for (const [id, t] of [...timeouts]) {
        if (t.ms === ms && !t.cancelled) { timeouts.delete(id); try { t.fn() } catch (e) {} }
      }
    },
    fireIntervals(ms) { for (const iv of [...intervals]) { if (ms === undefined || iv.ms === ms) { try { iv.fn() } catch (e) {} } } },
  }
}

// ---------- 假音频（验证内部提示音确实发声） ----------
function makeFakeAudio() {
  const started = []
  function AudioContext() {
    this.currentTime = 0
    this.state = 'running'
    this.destination = {}
    this.resume = () => Promise.resolve()
    this.createOscillator = () => ({ type: '', frequency: { value: 0 }, connect() {}, start(t) { started.push(t) }, stop() {} })
    this.createGain = () => ({ gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} })
  }
  return { AudioContext, started }
}

// ---------- 环境 ----------
let pendingFocus = true // 下一个 createEnv() 的初始聚焦状态（用于测「重新获得焦点」）
function createEnv(opts) {
  const options = opts || {}
  if (options.focused !== undefined) pendingFocus = !!options.focused
  const React = makeReact()
  const dom = makeDom()
  const sched = makeScheduler()
  const audio = makeFakeAudio()
  const registrations = []
  const rpcCalls = []
  const remoteHandlers = {}
  const windowListeners = {}

  const sessionsStore = { current: options.currentSession || 'sess-1', byId: {} }
  const opened = []
  const sessionsSvc = { list: { getSnapshot: () => sessionsStore }, open: (sid) => { opened.push(sid); return Promise.resolve() } }

  function fetchMock(url, init) {
    const body = JSON.parse(init.body)
    rpcCalls.push(body)
    const m = body.method
    let data = {}
    if (m === 'get-module-config') data = options.moduleConfig
    else if (m === 'get-reminders') {
      const since = (body.args && body.args.since) || 0
      const fresh = (options.reminders || []).filter((r) => r.id > since)
      data = { reminders: fresh, maxId: fresh.length ? fresh[fresh.length - 1].id : since }
    } else if (m === 'get-pending-setup') {
      data = options.pendingSetup || { pending: false, taskName: null, plannedMinutes: null, defaultPlannedMinutes: 60, reminderIntervalMinutes: 10 }
    } else if (m === 'get-status') {
      data = (options.statusFor && options.statusFor(body.args && body.args.sessionId)) || options.status || { active: false, configured: true, taskName: 'T', running: false, waitingDecision: false, elapsedMs: 0, plannedMs: 0, remindersFired: 0 }
    } else if (m === 'get-task-board') data = { active: [], finished: [], file: null }
    else if (m === 'get-external-status') data = { available: true, diagnostic: 'idle', toastDiag: '', inFront: !!options.inFront, externalWhen: 'hidden' }
    else if (m === 'get-config') data = Object.assign({ reminderIntervalMinutes: 10, plannedMinutes: 45, toastAppId: 'ai.deepseek.dsh.desktop', externalWhen: 'hidden', reminderAutoDismissSeconds: 4 }, options.config || {})
    else if (m === 'ui-presence') data = { ok: true, inFront: !!options.inFront }
    else if (m === 'get-pending-jump') data = { sessionId: options.pendingJump || null }
    else if (m === 'get-latest-decision-session') data = { sessionId: options.latestDecision || null }
    else if (m === 'set-session-config' || m === 'dismiss-session-setup' || m === 'reopen-session-setup' || m === 'clear-decision') data = { ok: true }
    else if (m === 'set-config' || m === 'set-module-config') data = { ok: true, config: options.moduleConfig }
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, data }) })
  }

  const slots = {
    inject: function (name, factory) { try { factory() } catch (e) {} return function () {} },
    register: function (meta, Component) { const e = Object.assign({}, meta, { Component }); registrations.push(e); return e },
  }

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    React,
    fetch: fetchMock,
    document: dom.document,
    window: {
      __ModuleLoader__: { load: (m) => { sandbox.__loaded = m } },
      addEventListener: (evt, fn) => { (windowListeners[evt] = windowListeners[evt] || []).push(fn) },
      focus: () => {},
      AudioContext: audio.AudioContext,
    },
    setTimeout: (fn, ms) => sched.setTimeout(fn, ms),
    clearTimeout: (id) => sched.clearTimeout(id),
    setInterval: (fn, ms) => sched.setInterval(fn, ms),
    clearInterval: (id) => sched.clearInterval(id),
    Notification: undefined,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Promise, Set, Map, Error, isFinite, parseInt, parseFloat,
  }
  sandbox.window.document = dom.document
  vm.createContext(sandbox)
  vm.runInContext(CLIENT_SRC, sandbox)

  const mod = sandbox.__loaded.factory((name) => (name === 'react' ? React : {}))
  const ctx = {
    sessions: sessionsSvc,
    slots,
    remote: { $on: (name, fn) => { (remoteHandlers[name] = remoteHandlers[name] || []).push(fn) } },
    effect: (fn) => { try { const c = fn(); return c || (() => {}) } catch (e) { return () => {} } },
  }

  return {
    mod, ctx, React, dom, sched, audio, registrations, rpcCalls, remoteHandlers, opened,
    mutable: options, // 可直接改这个对象来改变下一次 RPC 的返回值
    getEntry: (id) => registrations.find((r) => r.id === id),
    renderEntry: async (id, props) => {
      const e = registrations.find((r) => r.id === id)
      return e ? React.renderAsync(e.Component, props || {}) : null
    },
    mountEntry: (id, props) => {
      const e = registrations.find((r) => r.id === id)
      return e ? React.mount(e.Component, props || {}) : null
    },
    // 解开 wrapWithModuleCheck 包装层（外层只负责开关判断，真正的组件是它返回的元素），
    // 并用「异步渲染」等 RPC 数据落地后拿到最终元素树。
    resolveInner: async (id, props) => {
      const e = registrations.find((r) => r.id === id)
      if (!e) return { type: null, props: null, tree: null, found: false }
      let type = e.Component
      let p = props || {}
      for (let i = 0; i < 6; i++) {
        const out = await React.renderAsync(type, p)
        if (out && out.__el && typeof out.type === 'function') { type = out.type; p = out.props || {}; continue }
        return { type, props: p, tree: out, found: true }
      }
      return { type, props: p, tree: null, found: true }
    },
    mountInner: (resolved) => (resolved && resolved.type ? React.mount(resolved.type, resolved.props || {}) : null),
    fireRemote: (name, ...args) => { for (const fn of remoteHandlers[name] || []) fn(...args) },
    fireWindow: (evt) => { for (const fn of windowListeners[evt] || []) fn() },
    setCurrentSession: (sid) => { sessionsStore.current = sid },
    setReminders: (list) => { options.reminders = list },
    tick: () => new Promise((r) => setImmediate(r)),
  }
}

function allOn(over) {
  const mc = {
    timing: { enabled: true, children: { timer: true, planning: true, intervalReminder: true, taskBoard: true, dockStatus: true, orphanCleanup: true } },
    alert: { enabled: true, children: { decisionDetection: true, externalNotify: true, titleFlash: true, reminderUI: true, toastJump: true } },
  }
  if (over === 'noInternal') mc.alert.children.reminderUI = false
  return mc
}

// ---------- 元素树工具 ----------
function flattenText(n) {
  if (typeof n === 'string') return n
  if (Array.isArray(n)) return n.map(flattenText).join('')
  if (n && n.__el) return (n.children || []).map(flattenText).join('')
  return ''
}
function expandTree(node, depth) {
  const d = depth || 0
  if (d > 24) return node
  if (node == null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map((n) => expandTree(n, d + 1)).filter((x) => x != null && x !== false)
  if (!node.__el) return node
  const kids = (node.children || []).map((n) => expandTree(n, d + 1)).filter((x) => x != null && x !== false)
  if (typeof node.type === 'function') {
    const props = Object.assign({}, node.props, { children: kids })
    let rendered
    try { rendered = renderFunctionType ? renderFunctionType(node.type, props) : node.type(props) } catch (e) { return null }
    return expandTree(rendered, d + 1)
  }
  return { __el: true, type: node.type, props: node.props, children: kids }
}
function collect(node, pred, out) {
  const acc = out || []
  if (!node || typeof node !== 'object') return acc
  if (Array.isArray(node)) { node.forEach((n) => collect(n, pred, acc)); return acc }
  if (node.__el) {
    if (pred(node)) acc.push(node)
    ;(node.children || []).forEach((n) => collect(n, pred, acc))
  }
  return acc
}
function countDecisionCards(tree) {
  if (!tree) return 0
  return collect(expandTree(tree), (n) => {
    const cls = (n.props && n.props.className) || ''
    return typeof cls === 'string' && cls.split(/\s+/).indexOf('tt-reminder') >= 0 && cls.indexOf('tt-need-decision') >= 0
  }).length
}
function countNormalCards(tree) {
  if (!tree) return 0
  return collect(expandTree(tree), (n) => {
    const cls = (n.props && n.props.className) || ''
    return typeof cls === 'string' && cls.split(/\s+/).indexOf('tt-reminder') >= 0 && cls.indexOf('tt-need-decision') < 0
  }).length
}
function findByClass(tree, cls) {
  return collect(expandTree(tree), (n) => ((n.props && n.props.className) || '').indexOf(cls) >= 0)[0] || null
}
function findAllByClass(tree, cls) {
  return collect(expandTree(tree), (n) => ((n.props && n.props.className) || '').indexOf(cls) >= 0)
}

const DECISION = (id, sessionId, extra) => Object.assign({
  id, kind: 'decision', sessionId, taskName: '任务A', text: '需要你批准「pwsh」', ts: Date.now(), needDecision: true, autoMs: 0,
}, extra || {})

// ============================================================
// 场景 1：一条决策提醒 = 几张卡？× 能不能关掉？
// ============================================================
{
  const env = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', reminders: [DECISION(5, 'sess-2')] })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.sched.fireIntervals(2000) // 主轮询：从 host 拉提醒 → pushReminder
  await env.tick(); await env.tick()

  const domCards = env.dom.countCards()
  const reactCards = countDecisionCards(await env.renderEntry('task-time-reminder'))
  check('决策提醒：界面上只有 1 张「需要你决策」卡（不再 React + 直写 DOM 各画一张）', domCards + reactCards === 1, `DOM 卡 ${domCards} 张 + React 卡 ${reactCards} 张 = ${domCards + reactCards} 张`)
  check('决策提醒：不再有直写 DOM 的决策卡容器', domCards === 0, JSON.stringify(env.dom.cardInfo()))

  const inst = env.mountEntry('task-time-reminder')
  inst.render()
  const closeBtn = findByClass(inst.rerender(), 'tt-reminder-close')
  if (closeBtn && closeBtn.props.onClick) closeBtn.props.onClick({ stopPropagation() {} })
  await env.tick()
  const domAfterX = env.dom.countCards()
  const reactAfterX = countDecisionCards(inst.rerender())
  check('决策提醒：点 × 后卡片完全消失（不残留第二张）', domAfterX + reactAfterX === 0, `剩余 DOM 卡 ${domAfterX} 张 + React 卡 ${reactAfterX} 张`)

  // 点卡片本体：跳转到该会话并消卡
  const env2 = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', reminders: [DECISION(7, 'sess-9')] })
  env2.mod.apply(env2.ctx)
  await env2.tick(); await env2.tick()
  env2.sched.fireIntervals(2000)
  await env2.tick(); await env2.tick()
  const inst2 = env2.mountEntry('task-time-reminder')
  const card = findByClass(inst2.render(), 'tt-need-decision')
  if (card && card.props.onClick) card.props.onClick()
  await env2.tick()
  check('决策提醒：点卡片本体跳转后卡片消失', countDecisionCards(inst2.rerender()) === 0 && env2.opened.length === 1 && env2.opened[0] === 'sess-9', JSON.stringify(env2.opened))
  // 跳转后下一次轮询（2 秒）应把标题恢复（不再继续闪「需要你决策」）
  env2.sched.fireIntervals(2000)
  await env2.tick()
  env2.sched.fireIntervals(1000)
  check('决策提醒：手动消卡后标题闪烁停止（下一次轮询内）', env2.dom.document.title === 'DSH', env2.dom.document.title)
}

// ============================================================
// 场景 2：决策已处理（host 发 decision-cleared）后，红卡与标题闪烁是否收场
// ============================================================
{
  const env = createEnv({ moduleConfig: allOn(), currentSession: 'sess-2', reminders: [DECISION(61, 'sess-2')] })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.sched.fireIntervals(2000)
  await env.tick(); await env.tick()
  const inst = env.mountEntry('task-time-reminder')
  const before = countDecisionCards(inst.render())
  check('决策收场：处理前有 1 张决策卡', before === 1 && env.dom.countCards() === 0, `React ${before} + DOM ${env.dom.countCards()}`)

  // 用户在审批弹窗里点了「允许」→ host 推出「决策已处理」普通提醒
  env.setReminders([
    { id: 62, kind: 'decision-cleared', sessionId: 'sess-2', taskName: '任务A', text: '✅ 决策已处理：审批：approved', ts: Date.now(), needDecision: false, autoMs: 4000 },
  ])
  env.sched.fireIntervals(2000)
  await env.tick(); await env.tick()
  const afterReact = countDecisionCards(inst.rerender())
  const afterDom = env.dom.countCards()
  check('决策收场：决策处理后红色「需要你决策」卡应立即消失', afterReact + afterDom === 0, `剩余 React ${afterReact} + DOM ${afterDom}（decision-cleared 只推了一条普通卡，没人移除旧决策卡）`)
  env.sched.fireIntervals(1000)
  check('决策收场：决策处理后标题不再闪烁', env.dom.document.title === 'DSH', env.dom.document.title)
}

// ============================================================
// 场景 3：模块开关（内部通知关）能否管住提醒卡
// ============================================================
{
  const mc = allOn('noInternal') // 只关「内部通知」，定时提醒仍开（默认状态）
  const env = createEnv({ moduleConfig: mc, currentSession: 'sess-1' })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.fireRemote('approval/request', { agent: { id: 'sess-1' }, toolName: 'pwsh' }, () => {})
  await env.tick(); await env.tick()

  const domCards = env.dom.countCards()
  const reactCards = countDecisionCards(await env.renderEntry('task-time-reminder'))
  check('模块开关：关掉「内部通知」后不再显示提醒卡', reactCards === 0, `仍有 React 卡 ${reactCards} 张（ReminderGate 以前用的是「reminderUI 或 intervalReminder」，定时提醒开着就照样渲染）`)
  check('模块开关：关掉「内部通知」后也不应创建直写 DOM 的决策卡', domCards === 0, `仍有 DOM 卡 ${domCards} 张`)
}

// ============================================================
// 场景 4：本地 approval 检测 + host 轮询 = 几张卡
// ============================================================
{
  const env = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', reminders: [DECISION(21, 'sess-1')] })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.fireRemote('approval/request', { agent: { id: 'sess-1' }, toolName: 'pwsh' }, () => {})
  await env.tick()
  const afterRemote = countDecisionCards(await env.renderEntry('task-time-reminder'))
  env.sched.fireIntervals(2000) // host 也会推同一条决策
  await env.tick(); await env.tick()
  const afterPoll = countDecisionCards(await env.renderEntry('task-time-reminder'))
  const domCards = env.dom.countCards()
  check('决策去重：本地 approval 检测（负 id）与 host 提醒（正 id）合并成 1 张', afterPoll === 1, `本地后 ${afterRemote} 张 → host 推送后 ${afterPoll} 张（以前负 id 与正 id 未合并 → 一个会话两张红卡）`)
  check('决策去重：加起来仍只有 1 张', domCards + afterPoll === 1, `DOM ${domCards} + React ${afterPoll}`)
}

// ============================================================
// 场景 4b：点击系统通知回到 DSH → 自动跳到「等你决策」的会话
// ============================================================
{
  const env = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', inFront: false, focused: false })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  // host 侧：有一个别的会话在等决策
  env.mutable.latestDecision = 'sess-77'
  env.sched.fireIntervals(2000) // 轮询 tick（此时未聚焦）
  await env.tick(); await env.tick()
  env.opened.length = 0
  env.dom.document.hasFocus = () => true
  env.sched.fireIntervals(2000) // 下一次 tick 检测到「重新获得焦点」
  await env.tick(); await env.tick(); await env.tick()
  check('焦点兜底：窗口重新获得焦点后跳到「等你决策」的会话', env.opened.length === 1 && env.opened[0] === 'sess-77', JSON.stringify(env.opened))

  const env2 = createEnv({ moduleConfig: allOn(), currentSession: 'sess-77', inFront: false, focused: false })
  env2.mod.apply(env2.ctx)
  await env2.tick(); await env2.tick()
  env2.mutable.latestDecision = 'sess-77' // 已经在等决策的那个会话里 → 不该再跳
  env2.sched.fireIntervals(2000)
  await env2.tick(); await env2.tick()
  env2.opened.length = 0
  env2.dom.document.hasFocus = () => true
  env2.sched.fireIntervals(2000)
  await env2.tick(); await env2.tick(); await env2.tick()
  check('焦点兜底：已经在该会话里就不跳转（避免无意义跳转）', env2.opened.length === 0, JSON.stringify(env2.opened))

  // 跳转请求文件优先：host 返回 pendingJump 时用它指定的会话
  const env3 = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', inFront: false, focused: false, pendingJump: 'sess-99' })
  env3.mod.apply(env3.ctx)
  await env3.tick(); await env3.tick()
  env3.mutable.latestDecision = 'sess-77'
  env3.opened.length = 0
  env3.dom.document.hasFocus = () => true
  env3.sched.fireIntervals(2000)
  await env3.tick(); await env3.tick(); await env3.tick()
  check('焦点兜底：有跳转请求文件时按文件里的会话跳转', env3.opened.includes('sess-99'), JSON.stringify(env3.opened))
}

// ============================================================
// 场景 5：普通提醒卡的生命周期（按配置的滞留时长自动消散 + 淡出）
// ============================================================
{
  const env = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1',
    reminders: [{ id: 31, kind: 'finish', sessionId: 'sess-1', taskName: '任务A', text: '✅ 任务结束：累计实际用时 30 分钟', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.sched.fireIntervals(2000)
  await env.tick(); await env.tick()
  const inst = env.mountEntry('task-time-reminder')
  check('普通提醒：卡片渲染出来', countNormalCards(inst.render()) === 1, JSON.stringify(countNormalCards(inst.rerender())))
  env.sched.fireMs(4000) // 保持时长到 → 进入淡出
  const fading = findAllByClass(inst.rerender(), 'tt-fading').length
  check('普通提醒：4 秒后进入淡出（tt-fading）', fading === 1, 'fading=' + fading)
  env.sched.fireMs(1000) // 淡出结束 → 移除
  check('普通提醒：淡出结束后自动消失', countNormalCards(inst.rerender()) === 0, '仍有卡片')
}

// ============================================================
// 场景 5b：滞留时长可配置（host 下发的 autoMs 说了算）
// ============================================================
{
  // 配置 10 秒：4 秒时不该消散，10 秒才进入淡出
  const env = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1',
    reminders: [{ id: 33, kind: 'interval', sessionId: 'sess-1', taskName: '任务A', text: '🔔 第 2 次提醒', ts: Date.now(), needDecision: false, autoMs: 10000 }],
  })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.sched.fireIntervals(2000)
  await env.tick(); await env.tick()
  const inst = env.mountEntry('task-time-reminder')
  check('滞留时长：卡片渲染出来', countNormalCards(inst.render()) === 1, '无卡片')
  env.sched.fireMs(4000)
  check('滞留时长：设为 10 秒时 4 秒不消散（旧硬编码已失效）', countNormalCards(inst.rerender()) === 1, '4 秒就没了')
  env.sched.fireMs(10000)
  check('滞留时长：设为 10 秒时到点进入淡出', findAllByClass(inst.rerender(), 'tt-fading').length === 1, '未进入淡出')
  env.sched.fireMs(1000)
  check('滞留时长：淡出结束后消失', countNormalCards(inst.rerender()) === 0, '仍有卡片')

  // 常驻（autoMs=0）：永远不自动消散，只能点 × 关闭
  const env2 = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1',
    reminders: [{ id: 34, kind: 'interval', sessionId: 'sess-1', taskName: '任务A', text: ' 常驻卡', ts: Date.now(), needDecision: false, autoMs: 0 }],
  })
  env2.mod.apply(env2.ctx)
  await env2.tick(); await env2.tick()
  env2.sched.fireIntervals(2000)
  await env2.tick(); await env2.tick()
  const inst2 = env2.mountEntry('task-time-reminder')
  check('滞留时长：常驻卡渲染出来', countNormalCards(inst2.render()) === 1, '无卡片')
  env2.sched.fireMs(60000)
  check('滞留时长：常驻卡等 60 秒也不消散（不是红卡，但同样只能手动关）', countNormalCards(inst2.rerender()) === 1, '常驻卡被自动清掉了')
  check('滞留时长：常驻卡没有淡出类名（不进入淡出流程）', findAllByClass(inst2.rerender(), 'tt-fading').length === 0, '进入淡出了')

  // client 本地生成的提醒卡（删除失败/测试通知等，不带 autoMs）跟随 host 配置：
  // 配置里是 9 秒 → 本地卡也要 9 秒才消散（以前是写死的 6/8 秒）
  const env3 = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1', config: { reminderAutoDismissSeconds: 9 },
  })
  env3.mod.apply(env3.ctx)
  await env3.tick(); await env3.tick()
  const settings = env3.mountEntry('task-time')
  const testBtn = findAllByClass(settings.render(), 'tt-btn')[0]
  check('滞留时长：设置页有「发送测试通知」按钮（用它触一张本地提醒卡）', !!(testBtn && testBtn.props.onClick), '按钮没找到')
  if (testBtn && testBtn.props.onClick) testBtn.props.onClick()
  await env3.tick(); await env3.tick()
  const cards3 = env3.mountEntry('task-time-reminder')
  check('滞留时长：本地提醒卡渲染出来', countNormalCards(cards3.render()) === 1, '无卡片')
  env3.sched.fireMs(4000)
  check('滞留时长：本地卡 4 秒时仍在（跟随 9 秒配置，不再是写死的 4/6/8 秒）', countNormalCards(cards3.rerender()) === 1, '4 秒就没了')
  env3.sched.fireMs(9000)
  check('滞留时长：本地卡到配置的 9 秒才进入淡出', findAllByClass(cards3.rerender(), 'tt-fading').length === 1, '未进入淡出')

  // 设置页的入口：提醒模块下要有「提醒卡滞留时长」这一行，且下拉带「常驻」选项
  const settingsText = flattenText(expandTree(settings.render()))
  check('滞留时长：设置页有「提醒卡滞留时长」配置行', /提醒卡滞留时长/.test(settingsText), settingsText.slice(0, 120))
  const cardSelect = findAllByClass(settings.render(), 'tt-select').filter(function (n) {
    return flattenText(expandTree(n)).indexOf('常驻（不自动消散）') >= 0
  })[0]
  check('滞留时长：下拉含「常驻（不自动消散）」选项', !!cardSelect, '没找到滞留时长下拉')
  check('滞留时长：非预设值（9 秒）走「自定义…」+ 数字输入', !!cardSelect && cardSelect.props.value === 'custom', cardSelect && cardSelect.props.value)

  // 预设值（4 秒）时下拉直接显示 4 秒，不显示自定义输入框
  const env4 = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', config: { reminderAutoDismissSeconds: 4 } })
  env4.mod.apply(env4.ctx)
  await env4.tick(); await env4.tick()
  const settings4 = env4.mountEntry('task-time')
  const cardSelect4 = findAllByClass(settings4.render(), 'tt-select').filter(function (n) {
    return flattenText(expandTree(n)).indexOf('常驻（不自动消散）') >= 0
  })[0]
  check('滞留时长：预设值（4 秒）时下拉选中 4 秒', !!cardSelect4 && cardSelect4.props.value === '4', cardSelect4 && cardSelect4.props.value)
}

// ============================================================
// 场景 6：内部提示音（在 DSH 里才响，关掉内部通知不响）
// ============================================================
{
  const env = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1', inFront: true,
    reminders: [{ id: 41, kind: 'interval', sessionId: 'sess-1', taskName: '任务A', text: ' 第 1 次提醒', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  const before = env.audio.started.length
  env.sched.fireIntervals(2000)
  await env.tick(); await env.tick()
  check('内部提示音：人在 DSH 里收到提醒时发声', env.audio.started.length - before >= 2, 'oscillators=' + (env.audio.started.length - before))

  const env2 = createEnv({
    moduleConfig: allOn('noInternal'), currentSession: 'sess-1', inFront: true,
    reminders: [{ id: 42, kind: 'interval', sessionId: 'sess-1', taskName: '任务A', text: '🔔 第 1 次提醒', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env2.mod.apply(env2.ctx)
  await env2.tick(); await env2.tick()
  env2.sched.fireIntervals(2000)
  await env2.tick(); await env2.tick()
  check('内部提示音：关掉内部通知后不发声', env2.audio.started.length === 0, 'oscillators=' + env2.audio.started.length)

  const env3 = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1', inFront: false,
    reminders: [{ id: 43, kind: 'interval', sessionId: 'sess-1', taskName: '任务A', text: '🔔 第 1 次提醒', ts: Date.now(), needDecision: false, autoMs: 4000 }],
  })
  env3.mod.apply(env3.ctx)
  await env3.tick(); await env3.tick()
  env3.sched.fireIntervals(2000)
  await env3.tick(); await env3.tick()
  check('内部提示音：人不在 DSH 时不响（交给系统通知）', env3.audio.started.length === 0, 'oscillators=' + env3.audio.started.length)
}

// ============================================================
// 场景 7：标题闪烁
// ============================================================
{
  const env = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', reminders: [DECISION(51, 'sess-2')] })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()
  env.sched.fireIntervals(2000)
  await env.tick(); await env.tick()
  env.sched.fireIntervals(1000)
  check('标题闪烁：有待决策时标题变成「需要你决策」', /需要你决策/.test(env.dom.document.title), env.dom.document.title)
  env.fireWindow('focus')
  await env.tick()
  check('标题闪烁：回到 DSH（window focus）后标题恢复', env.dom.document.title === 'DSH', env.dom.document.title)

  const mc2 = allOn()
  mc2.alert.children.titleFlash = false
  const env2 = createEnv({ moduleConfig: mc2, currentSession: 'sess-1', reminders: [DECISION(52, 'sess-2')] })
  env2.mod.apply(env2.ctx)
  await env2.tick(); await env2.tick()
  env2.sched.fireIntervals(2000)
  await env2.tick()
  env2.sched.fireIntervals(1000)
  check('标题闪烁：关掉「标题闪烁」开关后不再闪烁', env2.dom.document.title === 'DSH', env2.dom.document.title)
}

// ============================================================
// 场景 8：Dock 状态条各状态
// ============================================================
{
  const statuses = {
    run: { active: true, configured: true, taskName: '任务A', running: true, waitingDecision: false, elapsedMs: 61000, plannedMs: 600000, remindersFired: 1 },
    wait: { active: true, configured: true, taskName: '任务A', running: false, waitingDecision: true, elapsedMs: 61000, plannedMs: 600000, remindersFired: 1 },
    done: { active: false, configured: true, taskName: '任务A', running: false, waitingDecision: false, elapsedMs: 0, plannedMs: 0, remindersFired: 0, lastSummary: { plannedMs: 600000, actualMs: 900000, diffMs: 300000 } },
    unset: { active: false, configured: false, taskName: null, running: false, waitingDecision: false, elapsedMs: 0, plannedMs: 0, remindersFired: 0 },
  }
  const env = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', statusFor: () => statuses[env.currentStatus] })
  env.currentStatus = 'run'
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()

  const t1 = flattenText(expandTree((await env.resolveInner('task-time-status', { sessionId: 'sess-1' })).tree))
  check('Dock 状态条：显示任务名/运行中/已用/计划/提醒次数', /任务A/.test(t1) && /运行中/.test(t1) && /已用 1:01/.test(t1) && /计划 10 分钟/.test(t1) && /已提醒 1 次/.test(t1), t1)
  env.currentStatus = 'wait'
  const t2 = flattenText(expandTree((await env.resolveInner('task-time-status', { sessionId: 'sess-1' })).tree))
  check('Dock 状态条：需决策时显示红色提示与「已处理」按钮', /需要你决策/.test(t2) && /已处理/.test(t2), t2)
  env.currentStatus = 'done'
  const t3 = flattenText(expandTree((await env.resolveInner('task-time-status', { sessionId: 'sess-1' })).tree))
  check('Dock 状态条：任务结束后显示上次统计与超时差', /上次任务/.test(t3) && /超时/.test(t3), t3)
  env.currentStatus = 'unset'
  const r4 = await env.resolveInner('task-time-status', { sessionId: 'sess-1' })
  const t4 = flattenText(expandTree(r4.tree))
  check('Dock 状态条：未设置计划时给出「设置计划」入口', /未设置计划用时/.test(t4) && /设置计划/.test(t4), t4)
  const link = findByClass(r4.tree, 'tt-setup-link')
  if (link && link.props.onClick) link.props.onClick({ stopPropagation() {} })
  await env.tick()
  check('Dock 状态条：「设置计划」调用 reopen-session-setup', env.rpcCalls.some((c) => c.method === 'reopen-session-setup' && c.args.sessionId === 'sess-1'), JSON.stringify(env.rpcCalls.map((c) => c.method)))
}

// ============================================================
// 场景 9：设置弹窗（预填 / 开始 / 遮罩不跳过 / 跳过）
// ============================================================
{
  const env = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1',
    pendingSetup: { pending: true, taskName: null, plannedMinutes: null, defaultPlannedMinutes: 45, reminderIntervalMinutes: 12 },
  })
  env.mod.apply(env.ctx)
  await env.tick(); await env.tick()

  const resolved = await env.resolveInner('task-time-setup', {})
  const inst = env.mountInner(resolved)
  let tree = inst.render()
  await env.tick()
  tree = inst.rerender()
  await env.tick()
  tree = inst.rerender()
  const inputs = collect(expandTree(tree), (n) => n.type === 'input')
  check('设置弹窗：新会话自动弹出', collect(expandTree(tree), (n) => n.type === 'h3').length === 1, JSON.stringify(flattenText(expandTree(tree)).slice(0, 80)))
  check('设置弹窗：计划用时按设置页默认值预填（45）', inputs.some((i) => i.props.value === '45'), JSON.stringify(inputs.map((i) => i.props.value)))
  check('设置弹窗：提醒间隔预填（12）', inputs.some((i) => i.props.value === '12'), JSON.stringify(inputs.map((i) => i.props.value)))

  // 填任务名后点「开始」
  const nameInput = inputs.find((i) => i.props.placeholder === '本次任务做什么？')
  if (nameInput) nameInput.props.onChange({ target: { value: '  写测试  ' } })
  tree = inst.rerender()
  const startBtn = findByClass(tree, 'tt-setup-start')
  if (startBtn && startBtn.props.onClick) startBtn.props.onClick()
  await env.tick()
  const cfgCall = [...env.rpcCalls].reverse().find((c) => c.method === 'set-session-config')
  check('设置弹窗：「开始」提交任务名（去空格）+ 计划 + 间隔', !!cfgCall && cfgCall.args.taskName === '写测试' && cfgCall.args.plannedMinutes === 45 && cfgCall.args.reminderIntervalMinutes === 12, JSON.stringify(cfgCall && cfgCall.args))

  // 计划用时清空后点「开始」：本地就应拦住并给提示（以前会发出 plannedMinutes:null →
  // host 存下"已配置但没计划"的会话，任务永远不启动，按钮看起来像坏的）
  const envEmpty = createEnv({
    moduleConfig: allOn(), currentSession: 'sess-1',
    pendingSetup: { pending: true, taskName: null, plannedMinutes: null, defaultPlannedMinutes: 45, reminderIntervalMinutes: 12 },
  })
  envEmpty.mod.apply(envEmpty.ctx)
  await envEmpty.tick(); await envEmpty.tick()
  const instE = envEmpty.mountInner(await envEmpty.resolveInner('task-time-setup', {}))
  instE.render()
  await envEmpty.tick()
  let treeE = instE.rerender()
  await envEmpty.tick()
  treeE = instE.rerender()
  const planInput = collect(expandTree(treeE), (n) => n.type === 'input' && n.props.type === 'number')[0]
  if (planInput) planInput.props.onChange({ target: { value: '' } })
  treeE = instE.rerender()
  const startE = findByClass(treeE, 'tt-setup-start')
  if (startE && startE.props.onClick) startE.props.onClick()
  await envEmpty.tick()
  treeE = instE.rerender()
  check('设置弹窗：计划用时留空时本地拦截，不发 RPC', !envEmpty.rpcCalls.some((c) => c.method === 'set-session-config'), JSON.stringify(envEmpty.rpcCalls.map((c) => c.method)))
  check('设置弹窗：计划用时留空时给出可读提示', /计划用时/.test(flattenText(expandTree(treeE))), flattenText(expandTree(treeE)).slice(0, 160))
  check('设置弹窗：被拦截时弹窗不关闭', findByClass(treeE, 'tt-setup-card') !== null, '弹窗应保持打开')

  // 遮罩点击：给提示，绝不跳过
  const env2 = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', pendingSetup: { pending: true, taskName: null, plannedMinutes: null, defaultPlannedMinutes: 60, reminderIntervalMinutes: 10 } })
  env2.mod.apply(env2.ctx)
  await env2.tick(); await env2.tick()
  const resolved2 = await env2.resolveInner('task-time-setup', {})
  const inst2 = env2.mountInner(resolved2)
  inst2.render()
  await env2.tick()
  let tree2 = inst2.rerender()
  await env2.tick()
  tree2 = inst2.rerender()
  const backdrop = findByClass(tree2, 'tt-setup')
  if (backdrop && backdrop.props.onClick) backdrop.props.onClick()
  await env2.tick()
  tree2 = inst2.rerender()
  check('设置弹窗：点遮罩只给提示，不跳过', /不会因为点到外面而关闭/.test(flattenText(expandTree(tree2))), flattenText(expandTree(tree2)).slice(0, 200))
  check('设置弹窗：点遮罩不发 dismiss-session-setup', !env2.rpcCalls.some((c) => c.method === 'dismiss-session-setup'), JSON.stringify(env2.rpcCalls.map((c) => c.method)))

  // 点「跳过」
  const skipBtn = findByClass(tree2, 'tt-setup-skip')
  if (skipBtn && skipBtn.props.onClick) skipBtn.props.onClick()
  await env2.tick()
  check('设置弹窗：只有「跳过」按钮才发 dismiss-session-setup', env2.rpcCalls.some((c) => c.method === 'dismiss-session-setup' && c.args.sessionId === 'sess-1'), JSON.stringify(env2.rpcCalls.map((c) => c.method)))
  check('设置弹窗：有已配置会话不弹窗（pending=false）时渲染空', await (async () => {
    const env3 = createEnv({ moduleConfig: allOn(), currentSession: 'sess-1', pendingSetup: { pending: false } })
    env3.mod.apply(env3.ctx)
    await env3.tick(); await env3.tick()
    return (await env3.resolveInner('task-time-setup', {})).tree === null
  })(), '已配置会话不应渲染设置弹窗')
}

// ---------- 输出 ----------
console.log('=== dsh-task-time 客户端 UI 行为验证结果 ===')
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  →  ' + r.detail}`)
console.log(failures === 0 ? '全部通过' : `失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
