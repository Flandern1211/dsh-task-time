// dsh-task-time 全链路验证（host）：计时引擎 / 间隔提醒 / 超时提醒 / 通知通道 /
// 结束统计 / 任务面板操作 / 记录持久化 / task_plan_set 工具 / 决策生命周期 / 边界。
//
// 与 verify.mjs 的区别：
//  1) 用可注入的 toast spy 替换 spawn('powershell.exe', ...)，**不会真的弹系统通知**（旧套件会真弹）
//  2) 覆盖 verify.mjs 未覆盖的：定时/超时提醒、暂停续计、结束统计、end-task/drop-task/delete/clear、
//     task_plan_set、决策清除与过期、归档会话清理、get-pending-jump、externalWhen 分流、配置校验缺口
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const work = mkdtempSync(join(tmpdir(), 'dsh-tt-timing-'))
const STATE = join(work, 'state.json')
const MODULES = join(work, 'modules.json')
const LEGACY = join(work, 'legacy.json')
const JUMP = join(work, 'jump.json')

// ---------- 结论收集 ----------
let failures = 0
const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? 'PASS' : String(detail ?? 'FAIL') })
  if (!cond) failures++
}

// ---------- 给 lib/index.js 打桩（路径 + toast spawn） ----------
const src = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')
const stubs = {
  RECORDS_FILE: [`const RECORDS_FILE = join(homedir(), '.dsh', 'dsh-task-time-records.json')`, `const RECORDS_FILE = ${JSON.stringify(STATE)}`],
  MODULE_CONFIG_FILE: [`const MODULE_CONFIG_FILE = join(homedir(), '.dsh', 'dsh-task-time-modules.json')`, `const MODULE_CONFIG_FILE = ${JSON.stringify(MODULES)}`],
  JUMP_FILE: [`const JUMP_FILE = join(homedir(), '.dsh', 'dsh-task-time-pending-jump.json')`, `const JUMP_FILE = ${JSON.stringify(JUMP)}`],
  spawn: [
    `      const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' })`,
    `      const child = globalThis.__toastSpy(args)`,
  ],
}
let patched = src
const missedStubs = []
for (const [key, [from, to]] of Object.entries(stubs)) {
  if (!patched.includes(from)) { missedStubs.push(key); continue }
  patched = patched.replace(from, to)
}
patched = patched.replace(/const legacyCandidates = \[[\s\S]*?\]/, `const legacyCandidates = [${JSON.stringify(LEGACY)}]`)
if (!/legacyCandidates = \["/.test(patched)) missedStubs.push('legacyCandidates')
check('打桩：lib/index.js 关键路径全部替换成功（防止测试静默打到真实文件）', missedStubs.length === 0, '未命中：' + missedStubs.join(','))

// 全开模块配置（每个场景前写入，避免被上一场景污染）
const ALL_ON = {
  timing: { enabled: true, children: { timer: true, planning: true, intervalReminder: true, taskBoard: true, dockStatus: true, orphanCleanup: true } },
  alert: { enabled: true, children: { decisionDetection: true, externalNotify: true, titleFlash: true, reminderUI: true, toastJump: true } },
}
writeFileSync(MODULES, JSON.stringify(ALL_ON, null, 2), 'utf8')

// ---------- toast spy ----------
let toasts = []
globalThis.__toastSpy = (args) => {
  const map = {}
  for (let i = 0; i < args.length; i++) {
    if (typeof args[i] === 'string' && args[i].startsWith('-') && args[i + 1] !== undefined && !String(args[i + 1]).startsWith('-')) {
      map[args[i]] = args[i + 1]
    }
  }
  toasts.push(map)
  return { unref() {}, kill() {}, on() {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let instSeq = 0
const live = []

// ---------- 启动一个插件实例（真实 lib/index.js 副本 + mock ctx） ----------
async function start(stateObj, opts) {
  const options = opts || {}
  if (options.writeState !== false) writeFileSync(STATE, JSON.stringify(stateObj, null, 2))
  const file = join(work, `idx-${++instSeq}.mjs`)
  writeFileSync(file, patched, 'utf8')

  const routes = []
  const events = {}
  const effects = []
  const registrations = []
  let tool = null
  const agentsRef = { roots: (options.roots || []).map((id) => ({ id })), archived: options.archived || [] }
  const role = options.role || {}

  const ctx = {
    get: (name) => {
      if (name === 'agents') return { roots: () => agentsRef.roots, get: () => undefined, current: () => undefined }
      if (name === 'sessions') return undefined
      if (name === 'workspaceRegistry') return { archivedSessionIds: agentsRef.archived }
      if (name === 'userQuestions') return role.userQuestions
      return undefined
    },
    on: (name, fn) => { (events[name] = events[name] || []).push(fn); return () => { const l = events[name]; const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1) } },
    effect: (fn) => { const c = fn(); if (typeof c === 'function') effects.push(c); return () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    tools: { register: (t) => { tool = t; return () => {} } },
    systemPrompt: { section: () => () => {} },
  }

  const mod = await import(pathToFileURL(file).href)
  mod.apply(ctx)
  await sleep(260)

  const rpc = (method, args) => callRpc(routes[routes.length - 1], method, args)
  const fire = async (name, ...args) => {
    const list = events[name] || []
    const out = []
    for (const fn of list) out.push(await fn(...args))
    return out
  }
  const inst = {
    rpc, fire, events, routes, agentsRef, allToasts: () => toasts,
    tool: () => tool,
    teardown: () => { for (const c of effects) { try { c() } catch (e) {} } },
  }
  live.push(inst)
  return inst
}

function callRpc(route, method, args) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ method, args: args || {} }))
    const req = { on: (evt, cb) => { if (evt === 'data') setTimeout(() => cb(body), 0); if (evt === 'end') setTimeout(cb, 5) } }
    const chunks = []
    const res = { writeHead: () => {}, end: (b) => chunks.push(b) }
    route.handler(req, res)
      .then(() => {
        const parsed = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'))
        if (parsed.ok) resolve(parsed.data)
        else reject(new Error(parsed.error))
      })
      .catch(reject)
  })
}

function task(over) {
  return Object.assign({
    sessionId: 'x', startedAt: null, accumulatedMs: 0, running: false, waitingDecision: false,
    lastResumeAt: null, lastPauseAt: null, plannedMs: null, taskName: null,
    remindersFired: 0, overdueFired: false, lastSummary: null,
  }, over)
}
function stateOf(over) {
  return Object.assign({ records: [], defaults: { reminderIntervalMinutes: 10, plannedMinutes: 60 }, configs: {}, dismissed: [], tasks: {}, history: {} }, over)
}
function findReminders(rs, kind) { return rs.filter((r) => r.kind === kind) }
function inst_final_teardown() { for (const i of live) i.teardown() }

// ============================================================
// 场景 A：计时引擎（运行累加 / 暂停冻结 / 恢复续计）
// ============================================================
{
  const base = Date.now()
  const inst = await start(stateOf({
    configs: { A1: { taskName: '计时任务', plannedMinutes: 60, reminderIntervalMinutes: 600, configured: true } },
    tasks: { A1: task({ sessionId: 'A1', startedAt: base - 1000, accumulatedMs: 0, running: true, lastResumeAt: base - 1000, plannedMs: 3600000, taskName: '计时任务' }) },
  }), { roots: ['A1'] })

  const s1 = await inst.rpc('get-status', { sessionId: 'A1' })
  check('计时：运行中会话 active=true / running=true', s1.active === true && s1.running === true, JSON.stringify(s1))
  check('计时：计划用时下发（60 分钟）', s1.plannedMs === 3600000, JSON.stringify(s1))
  check('计时：重启后从「现在」续计（加载时 lastResumeAt 被重置，停机不计时）', s1.elapsedMs >= 0 && s1.elapsedMs < 2000, 'elapsed=' + s1.elapsedMs)

  await sleep(600)
  const s2 = await inst.rpc('get-status', { sessionId: 'A1' })
  check('计时：运行中时间持续累加', s2.elapsedMs - s1.elapsedMs >= 400, `${s1.elapsedMs} → ${s2.elapsedMs}`)

  await inst.fire('agent/status', { agent: { id: 'A1' }, status: 'idle' })
  const p1 = await inst.rpc('get-status', { sessionId: 'A1' })
  await sleep(700)
  const p2 = await inst.rpc('get-status', { sessionId: 'A1' })
  check('计时：暂停后 running=false', p1.running === false, JSON.stringify(p1))
  check('计时：暂停期间不再累加（等待用户输入不计时）', Math.abs(p2.elapsedMs - p1.elapsedMs) < 120, `${p1.elapsedMs} → ${p2.elapsedMs}`)

  await inst.fire('agent/status', { agent: { id: 'A1' }, status: 'running' })
  await sleep(700)
  const r2 = await inst.rpc('get-status', { sessionId: 'A1' })
  check('计时：恢复后接着累计（不清零）', r2.running === true && r2.elapsedMs - p2.elapsedMs >= 500, `${p2.elapsedMs} → ${r2.elapsedMs}`)
  check('计时：恢复续计未重置起始时间', typeof r2.startedAt === 'number' && r2.startedAt <= base, JSON.stringify(r2.startedAt))
  inst.teardown()
}

// ============================================================
// 场景 B：间隔提醒 + 超时提醒（3s tick）与去重
// ============================================================
{
  const base = Date.now()
  // 注意：重启恢复会把 running 任务的 lastResumeAt 重置为「现在」（停机不计时），
  // 所以"已经跑了 25 分钟"必须由 accumulatedMs 表达，而不是把 lastResumeAt 放到过去。
  const elapsedMs = 25 * 60000 // 间隔 10 分钟 → 应触发第 2 次提醒；计划 10 分钟 → 已超时
  toasts = []
  const inst = await start(stateOf({
    configs: { B1: { taskName: '提醒任务', plannedMinutes: 10, reminderIntervalMinutes: 10, configured: true } },
    tasks: { B1: task({ sessionId: 'B1', startedAt: base - elapsedMs, accumulatedMs: elapsedMs, running: true, lastResumeAt: base, plannedMs: 600000, taskName: '提醒任务' }) },
  }), { roots: ['B1'] })

  await sleep(3600)
  const rs = await inst.rpc('get-reminders', { since: 0 })
  const interval = findReminders(rs.reminders, 'interval')
  const overdue = findReminders(rs.reminders, 'overdue')
  check('间隔提醒：按累计运行时间触发第 2 次', interval.length >= 1 && /第 2 次提醒/.test(interval[0].text), JSON.stringify(rs.reminders.map((r) => r.text)))
  check('间隔提醒：文案含累计运行时长与计划', /\d+:\d\d/.test(interval[0] ? interval[0].text : '') && /计划 10 分钟/.test(interval[0] ? interval[0].text : ''), interval[0] && interval[0].text)
  check('间隔提醒：卡片带任务名', interval[0] && interval[0].taskName === '提醒任务', JSON.stringify(interval[0]))
  check('超时提醒：超过计划用时触发', overdue.length === 1 && /已超过计划用时/.test(overdue[0].text), JSON.stringify(rs.reminders.map((r) => r.text)))
  const st = await inst.rpc('get-status', { sessionId: 'B1' })
  check('间隔提醒：remindersFired 记为已到期次数（2）', st.remindersFired === 2, JSON.stringify(st))
  check('不在 DSH 时：间隔/超时各发一条系统通知', toasts.length === 2, JSON.stringify(toasts))
  check('不在 DSH：间隔提醒声音 = Notification.Reminder', toasts.some((t) => t['-Sound'] === 'ms-winsoundevent:Notification.Reminder'), JSON.stringify(toasts))
  check('不在 DSH：超时提醒声音 = Looping.Alarm2', toasts.some((t) => t['-Sound'] === 'ms-winsoundevent:Notification.Looping.Alarm2'), JSON.stringify(toasts))
  check('系统通知：标题带任务名与次数', toasts.some((t) => /提醒任务/.test(t['-Title'] || '') && /第 2 次提醒/.test(t['-Title'] || '')), JSON.stringify(toasts.map((t) => t['-Title'])))

  await sleep(3400)
  const rs2 = await inst.rpc('get-reminders', { since: 0 })
  check('间隔提醒：同一到期次数不重复提醒', findReminders(rs2.reminders, 'interval').length === 1, JSON.stringify(rs2.reminders.map((r) => `${r.kind}:${r.text.slice(0, 18)}`)))
  check('超时提醒：只提醒一次（不刷屏）', findReminders(rs2.reminders, 'overdue').length === 1, JSON.stringify(rs2.reminders.map((r) => r.kind)))
  check('系统通知：第二轮 tick 不再重复发系统通知', toasts.length === 2, JSON.stringify(toasts.length))
  inst.teardown()
}

// ============================================================
// 场景 C：人在 DSH 里 vs 不在（externalWhen 两种时机）—— 通知不重复发
// ============================================================
{
  toasts = []
  const inst = await start(stateOf({
    configs: {
      C1: { taskName: '分流任务', plannedMinutes: 60, reminderIntervalMinutes: 10, configured: true },
      C2: { taskName: '离开后任务', plannedMinutes: 60, reminderIntervalMinutes: 10, configured: true },
    },
    tasks: {
      C1: task({ sessionId: 'C1', startedAt: Date.now(), plannedMs: 3600000, running: true, lastResumeAt: Date.now(), taskName: '分流任务' }),
      C2: task({ sessionId: 'C2', startedAt: Date.now(), plannedMs: 3600000, running: true, lastResumeAt: Date.now(), taskName: '离开后任务' }),
    },
  }), { roots: ['C1', 'C2'] })

  const p1 = await inst.rpc('ui-presence', { focused: true, visible: true })
  check('分流：页面可见且前台 → inFront=true', p1.inFront === true, JSON.stringify(p1))
  await inst.rpc('trigger-decision-alert', { sessionId: 'C1', toolName: 'pwsh' })
  check('分流：人在 DSH 里时不发系统通知（只走内部提醒卡）', toasts.length === 0, JSON.stringify(toasts))

  const p2 = await inst.rpc('ui-presence', { focused: false, visible: true })
  check('分流：默认时机=DSH 不在前台时 → 失焦即算离开（发系统通知）', p2.inFront === false, JSON.stringify(p2))
  await inst.rpc('set-config', { config: { externalWhen: 'hidden' } })
  const p2b = await inst.rpc('ui-presence', { focused: false, visible: true })
  check('分流：切到「只有页面不可见时」→ 页面可见即算在 DSH', p2b.inFront === true, JSON.stringify(p2b))
  await inst.rpc('set-config', { config: { externalWhen: 'unfocused' } })
  const p3 = await inst.rpc('ui-presence', { focused: false, visible: true })
  check('分流：切回「DSH 不在前台时」后失焦即算离开', p3.inFront === false, JSON.stringify(p3))
  await inst.rpc('trigger-decision-alert', { sessionId: 'C2', toolName: 'pwsh' })
  check('分流：离开 DSH 时才发系统通知', toasts.length === 1, JSON.stringify(toasts))
  check('决策提醒声音 = Looping.Alarm', toasts[0] && toasts[0]['-Sound'] === 'ms-winsoundevent:Notification.Looping.Alarm', JSON.stringify(toasts))
  await inst.rpc('trigger-decision-alert', { sessionId: 'C2', toolName: 'pwsh' })
  check('分流：同一会话 20 秒内不重复发系统通知（节流）', toasts.length === 1, JSON.stringify(toasts.length))
  const ext = await inst.rpc('get-external-status', {})
  check('分流：设置页可读到当前判定与时机', ext.inFront === false && ext.externalWhen === 'unfocused', JSON.stringify(ext))
  inst.teardown()
}

// ============================================================
// 场景 D：任务结束统计（agent/disposed）+ 记录符号约定
// ============================================================
{
  const base = Date.now()
  toasts = []
  const inst = await start(stateOf({
    configs: { D1: { taskName: '结束任务', plannedMinutes: 60, configured: true } },
    tasks: { D1: task({ sessionId: 'D1', startedAt: base - 30 * 60000, accumulatedMs: 1800000, running: true, lastResumeAt: base - 60000, plannedMs: 3600000, taskName: '结束任务', remindersFired: 3 }) },
  }), { roots: ['D1'] })

  await inst.fire('agent/disposed', { agent: { id: 'D1' } })
  const rs = await inst.rpc('get-reminders', { since: 0 })
  const fin = findReminders(rs.reminders, 'finish')
  check('结束：发出「任务结束」提醒', fin.length === 1, JSON.stringify(rs.reminders.map((r) => r.kind)))
  check('结束：统计累计实际用时（30 分钟）', fin[0] && /累计实际用时 30 分钟/.test(fin[0].text), fin[0] && fin[0].text)
  check('结束：给出与计划的差距（提前 30 分钟）', fin[0] && /提前 30 分钟/.test(fin[0].text), fin[0] && fin[0].text)
  check('结束：系统通知标题标出任务「结束」+ IM 声音', toasts.some((t) => /任务结束/.test(t['-Title'] || '') && t['-Sound'] === 'ms-winsoundevent:Notification.IM'), JSON.stringify(toasts))

  const board = await inst.rpc('get-task-board', {})
  const rec = (board.finished || []).find((r) => r.sessionId === 'D1')
  check('结束：写入已完成记录（含任务名/计划/实际）', !!rec && rec.taskName === '结束任务' && rec.plannedMs === 3600000, JSON.stringify(rec))
  check('结束：实际用时 ≈31 分钟（含最后 1 分钟运行）', rec && rec.actualMs >= 1800000 && rec.actualMs < 1920000, rec && rec.actualMs)
  check('结束：diffMs 约定为正=超时（此处为提前 → 负数）', rec && rec.diffMs === rec.actualMs - rec.plannedMs, JSON.stringify(rec))
  check('结束：active 列表不再包含该任务', !(board.active || []).some((a) => a.sessionId === 'D1'), JSON.stringify(board.active))
  const hist = await inst.rpc('get-history', { sessionId: 'D1' })
  check('结束：会话历史归档一条', (hist.records || []).length === 1, JSON.stringify(hist))
  await sleep(1000)
  const written = JSON.parse(readFileSync(STATE, 'utf8'))
  check('结束：记录已落盘', (written.records || []).some((r) => r.sessionId === 'D1'), JSON.stringify(written.records))
  check('结束：运行态已重置（startedAt=null）', written.tasks.D1 && written.tasks.D1.startedAt === null, JSON.stringify(written.tasks.D1))
  inst.teardown()
}

// ============================================================
// 场景 E：end-task（手动结束）记录的 diffMs 约定一致性
// ============================================================
{
  const base = Date.now()
  const inst = await start(stateOf({
    configs: { E1: { taskName: '手动结束', plannedMinutes: 60, configured: true } },
    tasks: { E1: task({ sessionId: 'E1', startedAt: base - 10 * 60000, accumulatedMs: 600000, running: true, lastResumeAt: base, plannedMs: 3600000, taskName: '手动结束' }) },
  }), { roots: ['E1'] })

  const d = await inst.rpc('end-task', { sessionId: 'E1' })
  check('end-task：返回 ok 与记录', !!(d && d.ok && d.record), JSON.stringify(d))
  const rec = d.record || {}
  check('end-task：实际用时正确（≈10 分钟）', rec.actualMs >= 600000 && rec.actualMs < 620000, rec.actualMs)
  check(
    'end-task：diffMs 与 finishTask 同约定（actualMs - plannedMs，正数=超时）',
    rec.diffMs === rec.actualMs - rec.plannedMs,
    `got diffMs=${rec.diffMs}, 期望 ${(rec.actualMs || 0) - (rec.plannedMs || 0)}（当前实现为 plannedMs-actualMs）`
  )
  const board = await inst.rpc('get-task-board', {})
  check('end-task：任务已从「进行中」移除并进入「已完成」', !(board.active || []).some((a) => a.sessionId === 'E1') && (board.finished || []).some((r) => r.sessionId === 'E1'), JSON.stringify(board))
  const pend = await inst.rpc('get-pending-setup', { sessionId: 'E1' })
  check('end-task：保留会话配置（不会重新弹设置窗）', pend.pending === false, JSON.stringify(pend))
  inst.teardown()
}

// ============================================================
// 场景 F：delete-task-record 后 history 是否落盘
// ============================================================
{
  const finishedAt = new Date().toISOString()
  const rec = { sessionId: 'F1', taskName: '待删除', startedAt: new Date(Date.now() - 600000).toISOString(), finishedAt, plannedMs: 600000, actualMs: 300000, diffMs: -300000 }
  const inst = await start(stateOf({
    records: [rec],
    configs: { F1: { taskName: '待删除', plannedMinutes: 10, configured: true } },
    tasks: { F1: task({ sessionId: 'F1', taskName: '待删除' }) },
    history: { F1: [rec] },
  }), { roots: ['F1'] })

  const d = await inst.rpc('delete-task-record', { sessionId: 'F1', finishedAt })
  check('删除记录：返回 ok', !!(d && d.ok), JSON.stringify(d))
  const inMem = await inst.rpc('get-history', { sessionId: 'F1' })
  check('删除记录：内存 history 已同步清理', (inMem.records || []).length === 0, JSON.stringify(inMem))

  await sleep(1200) // 越过 800ms 防抖窗口，看是否有人把它写回磁盘
  const onDisk = JSON.parse(readFileSync(STATE, 'utf8'))
  check('删除记录：records 已落盘（不含该记录）', !(onDisk.records || []).some((r) => r.sessionId === 'F1' && r.finishedAt === finishedAt), JSON.stringify(onDisk.records))
  check(
    '删除记录：history 同步落盘（不应残留已删除记录）',
    ((onDisk.history && onDisk.history.F1) || []).length === 0,
    '磁盘 history 仍有 ' + (((onDisk.history && onDisk.history.F1) || []).length) + ' 条（persistRecords() 在清理 history 之前调用，且之后没有 schedulePersist）'
  )
  const reloaded = await start(null, { writeState: false, roots: ['F1'] })
  const reHist = await reloaded.rpc('get-history', { sessionId: 'F1' })
  check('删除记录：重启后不会"复活"已删除的 history 条目', (reHist.records || []).length === 0, JSON.stringify(reHist))
  inst.teardown(); reloaded.teardown()
}

// ============================================================
// 场景 G：drop-task（残留清理）与 clear-task-records
// ============================================================
{
  const base = Date.now()
  const inst = await start(stateOf({
    configs: { G1: { taskName: '残留任务', plannedMinutes: 30, configured: true } },
    tasks: { G1: task({ sessionId: 'G1', startedAt: base - 300000, accumulatedMs: 60000, running: true, lastResumeAt: base, plannedMs: 1800000, taskName: '残留任务' }) },
  }), { roots: ['G1'] })

  const d = await inst.rpc('drop-task', { sessionId: 'G1' })
  check('drop-task：返回 ok + 任务名', !!(d && d.ok && d.taskName === '残留任务'), JSON.stringify(d))
  const board = await inst.rpc('get-task-board', {})
  check('drop-task：不写已完成记录（直接移除）', !(board.finished || []).some((r) => r.sessionId === 'G1') && !(board.active || []).some((a) => a.sessionId === 'G1'), JSON.stringify(board))
  const cfg = await inst.rpc('get-session-config', { sessionId: 'G1' })
  check('drop-task：保留会话配置', cfg.plannedMinutes === 30 && cfg.taskName === '残留任务', JSON.stringify(cfg))
  const d2 = await inst.rpc('drop-task', { sessionId: 'NOPE' })
  check('drop-task：无任务时返回可读错误', !!(d2 && d2.ok === false && /未找到/.test(d2.error || '')), JSON.stringify(d2))

  // 造一条已完成记录再清空
  await inst.rpc('set-session-config', { sessionId: 'G2', taskName: '待清空', plannedMinutes: 5, reminderIntervalMinutes: 5 })
  await inst.fire('agent/status', { agent: { id: 'G2' }, status: 'running' })
  await inst.fire('agent/status', { agent: { id: 'G2' }, status: 'idle' })
  await inst.fire('agent/disposed', { agent: { id: 'G2' } })
  const b2 = await inst.rpc('get-task-board', {})
  check('clear：先有一条已完成记录', (b2.finished || []).some((r) => r.sessionId === 'G2'), JSON.stringify(b2.finished))
  const c = await inst.rpc('clear-task-records', {})
  check('clear-task-records：返回 ok', !!(c && c.ok), JSON.stringify(c))
  const b3 = await inst.rpc('get-task-board', {})
  check('clear-task-records：记录被清空', (b3.finished || []).length === 0, JSON.stringify(b3.finished))
  await sleep(1000)
  const onDisk = JSON.parse(readFileSync(STATE, 'utf8'))
  check('clear-task-records：清空已落盘', (onDisk.records || []).length === 0 && Object.keys(onDisk.history || {}).length === 0, JSON.stringify(onDisk.records))
  inst.teardown()
}

// ============================================================
// 场景 H：task_plan_set 工具
// ============================================================
{
  const inst = await start(stateOf({}), { roots: ['H1'] })
  const tool = inst.tool()
  check('工具：task_plan_set 已注册且带参数 schema', !!tool && tool.name === 'task_plan_set' && tool.parameters.required.includes('plannedMinutes'), JSON.stringify(tool && tool.parameters))

  const r1 = await tool.execute({ plannedMinutes: 5, note: 'x' }, { agent: { id: 'H1' } })
  check('工具：设置计划用时返回成功', !!(r1 && r1.ok === true) && /5 分钟/.test(r1.message || ''), JSON.stringify(r1))
  const st = await inst.rpc('get-status', { sessionId: 'H1' })
  check('工具：计划用时生效（5 分钟 = 300000ms）', st.plannedMs === 300000, JSON.stringify(st))
  check('工具：会话被标记为已配置（不再弹设置窗）', st.configured === true, JSON.stringify(st))
  const pendTool = await inst.rpc('get-pending-setup', { sessionId: 'H1' })
  check('工具：pendingSetup 被清除', pendTool.pending === false, JSON.stringify(pendTool))
  const rs = await inst.rpc('get-reminders', { since: 0 })
  check('工具：给出设置确认提醒（含提醒间隔）', findReminders(rs.reminders, 'tool').length === 1 && /提醒/.test(findReminders(rs.reminders, 'tool')[0].text), JSON.stringify(rs.reminders.map((r) => r.text)))
  check('工具：output.render 输出文本', JSON.stringify(tool.output.render({}, { message: 'hi' })) === '[{"type":"text","text":"hi"}]', JSON.stringify(tool.output.render({}, { message: 'hi' })))

  const r2 = await tool.execute({ plannedMinutes: 5 }, {})
  check('工具：识别不到会话时返回失败', !!(r2 && r2.ok === false) && /无法识别当前会话/.test(r2.message), JSON.stringify(r2))
  const r3 = await tool.execute({ plannedMinutes: 0 }, { agent: { id: 'H1' } })
  check('工具：非法计划用时被夹到最小 1 分钟（不是报错）', !!(r3 && r3.ok === true) && /1 分钟/.test(r3.message || ''), JSON.stringify(r3))
  const r4 = await tool.execute({ plannedMinutes: 90 }, { agent: { id: 'H1' } })
  const rs2 = await inst.rpc('get-reminders', { since: 0 })
  check('工具：调整计划后重置超时标记', !!(r4 && r4.ok), JSON.stringify(r4))
  inst.teardown()
}

// ============================================================
// 场景 I：决策提醒生命周期（触发 / 清除 / 过期自愈）
// ============================================================
{
  const base = Date.now()
  const inst = await start(stateOf({
    configs: {
      I1: { taskName: '过期决策', plannedMinutes: 60, reminderIntervalMinutes: 600, configured: true },
      I2: { taskName: '审批会话', plannedMinutes: 60, reminderIntervalMinutes: 600, configured: true },
    },
    tasks: {
      // I1：暂停中（idle）且需决策状态卡了 2 分钟以上 → tick 应自愈清除
      I1: task({ sessionId: 'I1', startedAt: base - 121000, accumulatedMs: 0, running: false, lastResumeAt: null, lastPauseAt: null, waitingDecision: true, plannedMs: 3600000, taskName: '过期决策' }),
      I2: task({ sessionId: 'I2', startedAt: base, accumulatedMs: 0, running: true, lastResumeAt: base, plannedMs: 3600000, taskName: '审批会话' }),
    },
  }), { roots: ['I1', 'I2'] })

  let nextCalled = false
  await inst.fire('approval/request', { agent: { id: 'I2' }, toolName: 'pwsh', reason: '需要更高权限' }, async () => { nextCalled = true })
  check('决策：approval/request 不阻断审批链（next 被调用）', nextCalled === true, 'next not called')
  const s2 = await inst.rpc('get-status', { sessionId: 'I2' })
  check('决策：会话标记为 waitingDecision', s2.waitingDecision === true, JSON.stringify(s2))
  const rs = await inst.rpc('get-reminders', { since: 0 })
  const card = rs.reminders.find((r) => r.needDecision)
  check('决策：生成红色常驻提醒卡（autoMs=0）', !!card && card.autoMs === 0 && /批准/.test(card.text), JSON.stringify(rs.reminders))
  const latest = await inst.rpc('get-latest-decision-session', {})
  check('决策：get-latest-decision-session 指向该会话', latest.sessionId === 'I2', JSON.stringify(latest))

  await inst.fire('session/event', { id: 'I2' }, { type: 'approval/decided', data: { outcome: 'approved' } })
  const s3 = await inst.rpc('get-status', { sessionId: 'I2' })
  check('决策：用户审批后自动清除 waitingDecision', s3.waitingDecision === false, JSON.stringify(s3))
  const rs2 = await inst.rpc('get-reminders', { since: 0 })
  check('决策：清除时给出「决策已处理」提示', findReminders(rs2.reminders, 'decision-cleared').length >= 1, JSON.stringify(rs2.reminders.map((r) => r.kind)))

  const clr = await inst.rpc('clear-decision', { sessionId: 'I2' })
  check('决策：已清除的会话再清除返回 cleared=false（幂等）', !!(clr && clr.ok && clr.cleared === false), JSON.stringify(clr))

  // I1：暂停 2 分钟以上仍挂着 waitingDecision → 3s tick 应自愈
  await sleep(3600)
  const s1 = await inst.rpc('get-status', { sessionId: 'I1' })
  check('决策：长时间挂起的 waitingDecision 自动清除（防止永久滞留）', s1.waitingDecision === false, JSON.stringify(s1))
  const rs3 = await inst.rpc('get-reminders', { since: 0 })
  check('决策：过期自愈给出说明提醒', findReminders(rs3.reminders, 'decision-cleared').some((r) => /自动清除/.test(r.text)), JSON.stringify(rs3.reminders.map((r) => r.text)))
  inst.teardown()
}

// ============================================================
// 场景 J：get-pending-jump（toast 点击兜底 + 5 分钟过期）
// ============================================================
{
  const inst = await start(stateOf({}), { roots: [] })
  writeFileSync(JUMP, JSON.stringify({ sessionId: 'J1', ts: Date.now() }), 'utf8')
  const j1 = await inst.rpc('get-pending-jump', {})
  check('跳转兜底：读到待跳转会话', j1.sessionId === 'J1', JSON.stringify(j1))
  check('跳转兜底：读取后消费掉文件（不重复跳转）', !existsSync(JUMP), '文件仍在')
  const j2 = await inst.rpc('get-pending-jump', {})
  check('跳转兜底：无请求时返回 null', j2.sessionId === null, JSON.stringify(j2))

  writeFileSync(JUMP, JSON.stringify({ sessionId: 'J2', ts: Date.now() - 6 * 60000 }), 'utf8')
  const j3 = await inst.rpc('get-pending-jump', {})
  check('跳转兜底：超过 5 分钟的请求已过期', j3.sessionId === null, JSON.stringify(j3))
  check('跳转兜底：过期文件被清理', !existsSync(JUMP), '文件仍在')

  writeFileSync(JUMP, '{坏 JSON', 'utf8')
  const j4 = await inst.rpc('get-pending-jump', {})
  check('跳转兜底：损坏文件不抛错且被清理', j4.sessionId === null && !existsSync(JUMP), JSON.stringify(j4))
  inst.teardown()
}

// ============================================================
// 场景 K：归档会话的残留任务清理（workspaceRegistry.archivedSessionIds）
// ============================================================
{
  const base = Date.now()
  toasts = []
  const inst = await start(stateOf({
    configs: { K1: { taskName: '归档任务', plannedMinutes: 60, configured: true } },
    tasks: { K1: task({ sessionId: 'K1', startedAt: base - 120000, accumulatedMs: 60000, running: true, lastResumeAt: base - 60000, plannedMs: 3600000, taskName: '归档任务' }) },
  }), { roots: ['K1'], archived: ['K1'] })

  const b1 = await inst.rpc('get-task-board', {})
  check('归档：归档会话的进行中任务标为「会话已删除」', (b1.active || []).some((a) => a.sessionId === 'K1' && a.sessionGone === true), JSON.stringify(b1.active))

  await sleep(3600)
  const b2 = await inst.rpc('get-task-board', {})
  check('归档：3s tick 后不再显示为进行中', !(b2.active || []).some((a) => a.sessionId === 'K1'), JSON.stringify(b2.active))
  check('归档：静默收尾计入已完成（不发提醒/通知）', (b2.finished || []).some((r) => r.sessionId === 'K1') && toasts.length === 0, JSON.stringify(b2.finished))
  const rs = await inst.rpc('get-reminders', { since: 0 })
  check('归档：静默收尾不产生提醒卡', findReminders(rs.reminders, 'finish').length === 0, JSON.stringify(rs.reminders.map((r) => r.kind)))
  const onDisk = JSON.parse(readFileSync(STATE, 'utf8'))
  check('归档：残留配置被清除（会话若重开会重新询问计划）', !onDisk.configs.K1, JSON.stringify(Object.keys(onDisk.configs || {})))
  inst.teardown()
}

// ============================================================
// 场景 L：重启恢复（停机时间不计入）
// ============================================================
{
  const inst = await start(stateOf({
    configs: { L1: { taskName: '重启恢复', plannedMinutes: 60, configured: true } },
    tasks: { L1: task({ sessionId: 'L1', startedAt: Date.now() - 3600000, accumulatedMs: 600000, running: true, lastResumeAt: Date.now() - 3600000, plannedMs: 3600000, taskName: '重启恢复', remindersFired: 1 }) },
  }), { roots: ['L1'] })

  const st = await inst.rpc('get-status', { sessionId: 'L1' })
  check('重启恢复：累计用时保留（10 分钟）', st.elapsedMs >= 600000 && st.elapsedMs < 660000, 'elapsed=' + st.elapsedMs)
  check('重启恢复：停机 1 小时不计入（不是 70 分钟）', st.elapsedMs < 700000, 'elapsed=' + st.elapsedMs)
  check('重启恢复：提醒次数保留（避免重启后又从头提醒）', st.remindersFired === 1, JSON.stringify(st))
  check('重启恢复：任务名/计划保留', st.taskName === '重启恢复' && st.plannedMs === 3600000, JSON.stringify(st))
  inst.teardown()
}

// ============================================================
// 场景 M：配置边界（0 / 负数提醒间隔、空计划用时）
// ============================================================
{
  const base = Date.now()
  const inst = await start(stateOf({
    configs: { M1: { taskName: '负间隔', plannedMinutes: 60, reminderIntervalMinutes: -5, configured: true } },
    tasks: { M1: task({ sessionId: 'M1', startedAt: base - 3600000, accumulatedMs: 3600000, running: true, lastResumeAt: base - 3600000, plannedMs: 0, taskName: '负间隔' }) },
  }), { roots: ['M1'] })
  await sleep(3600)
  const rs = await inst.rpc('get-reminders', { since: 0 })
  const cfgFixed = await inst.rpc('get-session-config', { sessionId: 'M1' })
  check('边界：磁盘上的非法提醒间隔在加载时被修正为默认值（不再静默失效）', cfgFixed.reminderIntervalMinutes === 10, JSON.stringify(cfgFixed))
  check('边界：修正后按默认间隔正常提醒', findReminders(rs.reminders, 'interval').length >= 1, '实际提醒数=' + findReminders(rs.reminders, 'interval').length)
  const cfg = await inst.rpc('set-config', { config: { reminderIntervalMinutes: -5 } })
  check('边界：set-config 拒绝负数提醒间隔（保留原值）', cfg.reminderIntervalMinutes === 10, JSON.stringify(cfg))
  const cfgZero = await inst.rpc('set-config', { config: { reminderIntervalMinutes: 0 } })
  check('边界：set-config 拒绝 0 提醒间隔（保留原值）', cfgZero.reminderIntervalMinutes === 10, JSON.stringify(cfgZero))
  const cfgOk = await inst.rpc('set-config', { config: { reminderIntervalMinutes: 7 } })
  check('边界：set-config 接受合法提醒间隔（7 分钟）', cfgOk.reminderIntervalMinutes === 7, JSON.stringify(cfgOk))
  const cfgHuge = await inst.rpc('set-config', { config: { reminderIntervalMinutes: 100000 } })
  check('边界：set-config 把过大提醒间隔夹到 24 小时', cfgHuge.reminderIntervalMinutes === 1440, JSON.stringify(cfgHuge))
  inst.teardown()

  const inst2 = await start(stateOf({}), { roots: ['M2'] })
  const bad = await inst2.rpc('set-session-config', { sessionId: 'M2', taskName: '', plannedMinutes: null, reminderIntervalMinutes: 10 })
  check('边界：计划用时留空 → set-session-config 明确拒绝（而不是标记已配置但不计时）', bad.ok === false && !!bad.error, JSON.stringify(bad))
  const st = await inst2.rpc('get-status', { sessionId: 'M2' })
  check('边界：被拒绝后会话保持未配置（设置弹窗会重新出现）', st.configured === false, JSON.stringify(st))
  const rs2 = await inst2.rpc('get-reminders', { since: 0 })
  check('边界：被拒绝时不产生「设置完成」提醒文案', findReminders(rs2.reminders, 'setup').length === 0, JSON.stringify(rs2.reminders.map((r) => r.text)))
  const good = await inst2.rpc('set-session-config', { sessionId: 'M2', taskName: '  写测试  ', plannedMinutes: 0, reminderIntervalMinutes: 10 })
  check('边界：计划用时为 0 同样被拒绝', good.ok === false, JSON.stringify(good))
  const good2 = await inst2.rpc('set-session-config', { sessionId: 'M2', taskName: '  写测试  ', plannedMinutes: 45, reminderIntervalMinutes: 10 })
  check('边界：合法计划用时被接受', good2.ok === true, JSON.stringify(good2))
  const cfg2 = await inst2.rpc('get-session-config', { sessionId: 'M2' })
  check('边界：会话配置写入计划用时与去空格后的任务名', cfg2.plannedMinutes === 45 && cfg2.taskName === '写测试', JSON.stringify(cfg2))
  const rs2b = await inst2.rpc('get-reminders', { since: 0 })
  const setupMsg = findReminders(rs2b.reminders, 'setup')[0]
  check('边界：设置确认文案含具体计划分钟数（不是 null 分钟）', !!setupMsg && /45 分钟/.test(setupMsg.text) && !/null/.test(setupMsg.text), setupMsg && setupMsg.text)
  inst2.teardown()

  // 状态文件瘦身：dismissed / configs / rootSessions 超额时按插入顺序裁剪
  const manyDismissed = []
  for (let i = 0; i < 260; i++) manyDismissed.push('old-' + i)
  const manyConfigs = {}
  for (let i = 0; i < 260; i++) manyConfigs['old-' + i] = { taskName: 'T' + i, plannedMinutes: 30, reminderIntervalMinutes: 10, configured: true }
  manyConfigs['KEEP'] = { taskName: '活跃', plannedMinutes: 30, reminderIntervalMinutes: 10, configured: true }
  const inst3 = await start(
    { records: [], configs: manyConfigs, dismissed: manyDismissed, tasks: {}, history: {}, rootSessions: ['KEEP'] },
    { roots: ['KEEP'] }
  )
  // 触发一次落盘（set-config → 800ms 防抖），把裁剪后的状态写回磁盘
  await inst3.rpc('set-config', { config: { reminderIntervalMinutes: 11 } })
  await sleep(1100)
  const written = JSON.parse(readFileSync(STATE, 'utf8'))
  check('瘦身：dismissed 超过 200 条时被裁剪', (written.dismissed || []).length <= 201, 'dismissed=' + (written.dismissed || []).length)
  check('瘦身：configs 超过 200 条时被裁剪', Object.keys(written.configs || {}).length <= 201, 'configs=' + Object.keys(written.configs || {}).length)
  check('瘦身：活跃会话的配置被保留', !!written.configs && !!written.configs.KEEP, JSON.stringify(Object.keys(written.configs || {}).slice(-3)))
  check('瘦身：历史遗留键不再被写回磁盘', !JSON.stringify(written.configs || {}).includes('externalAlert'), JSON.stringify(written.configs && written.configs.KEEP))
  inst3.teardown()
}

// ============================================================
// 场景 M2：提醒卡滞留时长（可配置；0 = 常驻不自动消散）
// ============================================================
{
  const inst = await start(stateOf({}), { roots: ['O1', 'O2', 'O3'] })
  const cfg0 = await inst.rpc('get-config', {})
  check('滞留时长：默认 4 秒', cfg0.reminderAutoDismissSeconds === 4, JSON.stringify(cfg0))

  // 「设置完成」提醒卡是最快拿到的一张普通卡（不需要等计时 tick）
  await inst.rpc('set-session-config', { sessionId: 'O1', taskName: '默认卡', plannedMinutes: 30, reminderIntervalMinutes: 10 })
  const rs1 = await inst.rpc('get-reminders', { since: 0 })
  const card1 = rs1.reminders.filter((r) => r.sessionId === 'O1' && r.kind === 'setup')[0]
  check('滞留时长：普通提醒卡按默认值下发 autoMs=4000', !!card1 && card1.autoMs === 4000, JSON.stringify(card1))

  const cfg10 = await inst.rpc('set-config', { config: { reminderAutoDismissSeconds: 10 } })
  check('滞留时长：set-config 可设为 10 秒', cfg10.reminderAutoDismissSeconds === 10, JSON.stringify(cfg10))
  await inst.rpc('set-session-config', { sessionId: 'O2', taskName: '十秒卡', plannedMinutes: 30, reminderIntervalMinutes: 10 })
  const rs2 = await inst.rpc('get-reminders', { since: 0 })
  const card2 = rs2.reminders.filter((r) => r.sessionId === 'O2' && r.kind === 'setup')[0]
  check('滞留时长：新值立即生效（autoMs=10000）', !!card2 && card2.autoMs === 10000, JSON.stringify(card2))

  const cfgNeg = await inst.rpc('set-config', { config: { reminderAutoDismissSeconds: -3 } })
  check('滞留时长：拒绝负数（保留上一个合法值）', cfgNeg.reminderAutoDismissSeconds === 10, JSON.stringify(cfgNeg))
  const cfgHuge = await inst.rpc('set-config', { config: { reminderAutoDismissSeconds: 100000 } })
  check('滞留时长：过大值夹到 600 秒', cfgHuge.reminderAutoDismissSeconds === 600, JSON.stringify(cfgHuge))

  const cfgKeep = await inst.rpc('set-config', { config: { reminderAutoDismissSeconds: 0 } })
  check('滞留时长：0 合法 = 常驻不自动消散', cfgKeep.reminderAutoDismissSeconds === 0, JSON.stringify(cfgKeep))
  await inst.rpc('set-session-config', { sessionId: 'O3', taskName: '常驻卡', plannedMinutes: 30, reminderIntervalMinutes: 10 })
  const rs3 = await inst.rpc('get-reminders', { since: 0 })
  const card3 = rs3.reminders.filter((r) => r.sessionId === 'O3' && r.kind === 'setup')[0]
  check('滞留时长：常驻时普通卡 autoMs=0（等客户端点 × 才关）', !!card3 && card3.autoMs === 0, JSON.stringify(card3))

  // 决策红卡任何时候都必须常驻，不受该配置影响
  await inst.rpc('set-config', { config: { reminderAutoDismissSeconds: 30 } })
  await inst.rpc('trigger-decision-alert', { sessionId: 'O1', toolName: 'pwsh' })
  const rs4 = await inst.rpc('get-reminders', { since: 0 })
  const dec = rs4.reminders.filter((r) => r.needDecision)[0]
  check('滞留时长：决策红卡仍恒为常驻（autoMs=0）', !!dec && dec.autoMs === 0, JSON.stringify(dec))
  inst.teardown()

  // 落盘 → 重启 → 恢复：默认值要跟着文件回来，否则重启后卡片时长会悄悄回到 4 秒
  const inst2 = await start(stateOf({ defaults: { reminderIntervalMinutes: 10, plannedMinutes: 60, reminderAutoDismissSeconds: 0 } }), { roots: ['O4'] })
  const restored = await inst2.rpc('get-config', {})
  check('滞留时长：重启后从磁盘恢复（0 = 常驻）', restored.reminderAutoDismissSeconds === 0, JSON.stringify(restored))
  await inst2.rpc('set-session-config', { sessionId: 'O4', taskName: '恢复卡', plannedMinutes: 30, reminderIntervalMinutes: 10 })
  const rs5 = await inst2.rpc('get-reminders', { since: 0 })
  const card5 = rs5.reminders.filter((r) => r.sessionId === 'O4' && r.kind === 'setup')[0]
  check('滞留时长：恢复后的值用于新卡', !!card5 && card5.autoMs === 0, JSON.stringify(card5))
  inst2.teardown()
}

// ============================================================
// 场景 N：跨端集成点（通知点击跳转 / 决策会话定位）—— 谁写、谁消费
// ============================================================
{
  const toastSrc = readFileSync(join(__dirname, '..', 'lib', 'toast.ps1'), 'utf8')
  const clientSrc = readFileSync(join(__dirname, '..', 'lib', 'client.js'), 'utf8')
  // 「点击系统通知 → 跳到对应会话」的链路：toast.ps1 负责把 DSH 拉到前台（-Launch），
  // 点击本身由 client 的「窗口重新获得焦点」检测完成（PowerShell 无法订阅 WinRT 通知事件）。
  check(
    '通知点击跳转：toast.ps1 仍带 -Launch（点击横幅→激活 DSH 窗口）',
    /-Launch/.test(src) && /SelectSingleNode\("\/toast"\)/.test(toastSrc) && /SetAttribute\("launch"/.test(toastSrc),
    'host 要传 -Launch、toast.ps1 要把 launch 写进 toast XML，否则点横幅连窗口都不会到前台'
  )
  check(
    '通知点击跳转：toast.ps1 不再依赖 WinRT 事件回调（PS 5.1 订阅不到）',
    !/Register-ObjectEvent|add_Activated|add_Dismissed|Wait-Event/.test(toastSrc.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')),
    'toast.ps1 里若出现 WinRT 事件监听代码即为无效实现（订阅成功但回调不执行）'
  )
  check(
    '通知点击跳转：client 在窗口重新聚焦时会跳到「等你决策」的会话',
    /get-latest-decision-session/.test(clientSrc),
    'client 必须调用 get-latest-decision-session 完成跳转（否则该 RPC 是死代码、点击通知也不会跳）'
  )
  check(
    '通知点击跳转：jumpToSession 会清掉目标会话的决策卡',
    /function jumpToSession[\s\S]{0,600}dismissDecisionForSession\(sid\)/.test(clientSrc),
    '跳转后必须消卡，否则用户到了会话里红卡还挂着'
  )
  inst_final_teardown()
}

// ---------- 收尾 ----------
for (const i of live) i.teardown()
try { rmSync(work, { recursive: true, force: true }) } catch (e) {}

console.log('=== dsh-task-time 计时/提醒/记录 全链路验证结果 ===')
for (const r of results) console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  →  ' + r.detail}`)
console.log(failures === 0 ? '全部通过' : `失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)