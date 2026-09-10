// dsh-task-time 自动验证脚本（临时，不参与发布）
// 用真实 lib/index.js 代码 + mock 运行时，验证：
//  1) 旧格式记录文件 + legacy 迁移
//  2) configs/dismissed/tasks/history/defaults 重启恢复
//  3) get-pending-setup 对 configured/dismissed/新会话的正确判定
//  4) tools/pre-execute 决策提醒（ask_user_question 无论任务是否运行都提醒）
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- 准备临时目录 + 修改后的 index 副本 ----------
const work = mkdtempSync(join(tmpdir(), 'dsh-tt-verify-'))
const STATE = join(work, 'state.json')
const LEGACY = join(work, 'legacy.json')

const src = readFileSync(join(__dirname, '..', 'lib', 'index.js'), 'utf8')
let mod = src
  .replace(
    "const RECORDS_FILE = join(homedir(), '.dsh', 'dsh-task-time-records.json')",
    `const RECORDS_FILE = ${JSON.stringify(STATE)}`
  )
  .replace(
    /const legacyCandidates = \[[\s\S]*?\]/,
    `const legacyCandidates = [${JSON.stringify(LEGACY)}]`
  )
  .replace(
    "const f = join(homedir(), '.dsh', 'dsh-task-time-records.json')",
    `const f = ${JSON.stringify(STATE)}`
  )

const copyFile = join(work, 'index.mjs')
writeFileSync(copyFile, mod, 'utf8')

// ---------- mock 运行时 ----------
const disposers = []
const handlers = {} // RPC handlers
const eventHandlers = {} // ctx.on
const registeredRoutes = []

// userQuestions 服务 mock（可被插件 hook 包装 ask）
let userQuestionsSvc = null
function makeUserQuestions() {
  const svc = {
    ask: async (request) => ({ answers: [] }),
  }
  userQuestionsSvc = svc
  return svc
}

// agents 服务 mock（可配置 roots；默认空 —— 让 isRoot 走 agentsSvc 路径）
let agentRoots = []
function makeAgents() {
  return {
    roots: () => agentRoots,
  }
}

function makeCtx() {
  const svc = makeUserQuestions()
  return {
    get: (name, optional) => {
      if (name === 'userQuestions') return svc
      if (name === 'agents') return makeAgents()
      return undefined
    },
    on: (name, fn) => {
      eventHandlers[name] = fn
      const off = () => { delete eventHandlers[name] }
      disposers.push(off)
      return off
    },
    effect: (fn, label) => {
      const cleanup = fn()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return () => {}
    },
    webServer: {
      register: (route) => {
        registeredRoutes.push(route)
        return () => {}
      },
    },
    tools: {
      register: (tool) => () => {},
    },
    systemPrompt: {
      section: () => () => {},
    },
  }
}

function callRpc(method, args) {
  return new Promise((resolve, reject) => {
    const route = registeredRoutes[registeredRoutes.length - 1]
    const body = Buffer.from(JSON.stringify({ method, args: args || {} }))
    const req = {
      on: (evt, cb) => {
        if (evt === 'data') { setTimeout(() => cb(body), 0) }
        if (evt === 'end') { setTimeout(cb, 5) }
        if (evt === 'error') {}
      },
    }
    const chunks = []
    const res = {
      writeHead: (s, h) => { res.status = s },
      end: (body) => { chunks.push(body) },
    }
    route.handler(req, res).then(() => {
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8')
      const parsed = JSON.parse(text)
      if (parsed.ok) resolve(parsed.data)
      else reject(new Error(parsed.error))
    }).catch(reject)
  })
}

// ---------- 测试断言 ----------
let failures = 0
const results = []
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: cond ? 'PASS' : String(detail ?? 'FAIL') })
  if (!cond) failures++
}

// ---------- 场景 1：legacy 迁移（state 不存在，legacy 有数据） ----------
writeFileSync(LEGACY, JSON.stringify({
  records: [
    { sessionId: 'legacy-s1', taskName: '旧任务', startedAt: '2025-01-01T00:00:00Z', finishedAt: '2025-01-01T01:00:00Z', plannedMs: 3600000, actualMs: 3300000, diffMs: 300000 },
  ],
}, null, 2))

const mod1 = await import(pathToFileURL(copyFile).href)
const ctx1 = makeCtx()
mod1.apply(ctx1)
await new Promise((r) => setTimeout(r, 300)) // 等 ensureLoaded

const board1 = await callRpc('get-task-board', {})
check('legacy 迁移：finished 含旧记录', Array.isArray(board1.finished) && board1.finished.length === 1, board1)
check('legacy 迁移：任务名正确', board1.finished[0] && board1.finished[0].taskName === '旧任务', board1.finished)

// 停止第一个实例（避免 tick 干扰）
for (const off of disposers.splice(0)) { try { off() } catch (e) {} }
for (const off of registeredRoutes.splice(0)) {}

// ---------- 场景 2：完整状态恢复（configs/dismissed/tasks/history/defaults） ----------
const copyFile2 = join(work, 'index2.mjs')
writeFileSync(copyFile2, mod, 'utf8')
writeFileSync(STATE, JSON.stringify({
  records: [],
  defaults: { reminderIntervalMinutes: 25, externalAlert: false },
  configs: {
    'cfg-s1': { taskName: '已配置任务', plannedMinutes: 30, reminderIntervalMinutes: 12, externalAlert: false, configured: true },
    'old-no-configured': { taskName: '旧格式配置', plannedMinutes: 45 },
  },
  dismissed: ['dismissed-s1'],
  tasks: {
    'cfg-s1': {
      sessionId: 'cfg-s1', startedAt: Date.now() - 60000, accumulatedMs: 30000,
      running: true, waitingDecision: false, lastResumeAt: Date.now() - 1000,
      lastPauseAt: null, plannedMs: 1800000, taskName: '已配置任务',
      remindersFired: 0, overdueFired: false, lastSummary: null,
    },
  },
  history: { 'cfg-s1': [{ sessionId: 'cfg-s1', taskName: '历史记录', actualMs: 1000 }] },
}, null, 2))

const mod2 = await import(pathToFileURL(copyFile2).href)
const ctx2 = makeCtx()
agentRoots = [{ id: 'cfg-s1' }]
mod2.apply(ctx2)
await new Promise((r) => setTimeout(r, 300))

const board2 = await callRpc('get-task-board', {})
check('状态恢复：active 含运行中任务', Array.isArray(board2.active) && board2.active.some((a) => a.sessionId === 'cfg-s1'), board2)
check('状态恢复：active 任务运行中', board2.active.some((a) => a.sessionId === 'cfg-s1' && a.running === true), board2)
check('状态恢复：defaults 恢复 25 分钟', ((await callRpc('get-config', {}))).reminderIntervalMinutes === 25, 'defaults not 25')

const pendCfg = await callRpc('get-pending-setup', { sessionId: 'cfg-s1' })
check('configured 会话不再弹窗', pendCfg.pending === false, pendCfg)
const pendDismissed = await callRpc('get-pending-setup', { sessionId: 'dismissed-s1' })
check('dismissed 会话不再弹窗', pendDismissed.pending === false, pendDismissed)
const pendNew = await callRpc('get-pending-setup', { sessionId: 'brand-new-session' })
check('新会话仍弹窗', pendNew.pending === true, pendNew)

// 停第二个实例
for (const off of disposers.splice(0)) { try { off() } catch (e) {} }
for (const off of registeredRoutes.splice(0)) {}

// ---------- 场景 3：决策提醒（任务未运行也应提醒，三通道） ----------
const copyFile3 = join(work, 'index3.mjs')
writeFileSync(copyFile3, mod, 'utf8')
writeFileSync(STATE, JSON.stringify({
  records: [],
  defaults: { reminderIntervalMinutes: 10, externalAlert: true },
  configs: {
    'dec-s1': { taskName: '决策测试', plannedMinutes: 60, externalAlert: false, configured: true },
    'dec-s2': { taskName: '提问测试', plannedMinutes: 60, externalAlert: false, configured: true },
  },
  dismissed: [],
  tasks: {
    'dec-s1': { sessionId: 'dec-s1', startedAt: Date.now(), accumulatedMs: 0, running: false, waitingDecision: false, lastResumeAt: null, lastPauseAt: null, plannedMs: 3600000, taskName: '决策测试', remindersFired: 0, overdueFired: false, lastSummary: null },
    'dec-s2': { sessionId: 'dec-s2', startedAt: Date.now(), accumulatedMs: 0, running: false, waitingDecision: false, lastResumeAt: null, lastPauseAt: null, plannedMs: 3600000, taskName: '提问测试', remindersFired: 0, overdueFired: false, lastSummary: null },
  },
  history: {},
}, null, 2))

const mod3 = await import(pathToFileURL(copyFile3).href)
const ctx3 = makeCtx()
agentRoots = [{ id: 'dec-s1' }, { id: 'dec-s2' }]
mod3.apply(ctx3)
await new Promise((r) => setTimeout(r, 300))

// 通道 1：approval/request（任务 running=false 也应提醒）
const approvalHandler = eventHandlers['approval/request']
if (approvalHandler) {
  let nextCalled = false
  await approvalHandler({ agent: { id: 'dec-s1' }, toolName: 'pwsh', reason: '需要更高权限' }, async () => { nextCalled = true })
  check('通道1 approval：next 被调用（不阻断审批）', nextCalled === true, 'next not called')
}

const rems1 = await callRpc('get-reminders', { since: 0 })
const decision1 = (rems1.reminders || []).find((r) => r.needDecision)
check('通道1 approval：产生 needDecision 提醒卡', !!decision1, rems1)
check('通道1 approval：文本含工具名', decision1 && /批准/.test(decision1.text), decision1)

// 通道 2：userQuestions.ask hook（ask_user_question 提问，用 dec-s2 避开 approval 节流）
const uqSvc = userQuestionsSvc
if (uqSvc && typeof uqSvc.ask === 'function') {
  await uqSvc.ask({ questions: [{ id: 'q1', question: '请选择方案 A 还是 B？' }], agent: { id: 'dec-s2' } })
}
const rems2 = await callRpc('get-reminders', { since: 0 })
const decision2 = (rems2.reminders || []).find((r) => r.needDecision && /请前往 DSH/.test(r.text))
check('通道2 userQuestions：提问产生提醒卡', !!decision2, rems2)
check('通道2 userQuestions：文本为简短提示', decision2 && /请前往 DSH/.test(decision2.text), decision2)

// 重复触发（20s 节流内）不应重复
const before = (await callRpc('get-reminders', { since: 0 })).reminders.length
await uqSvc.ask({ questions: [{ id: 'q2', question: '重复提问' }], agent: { id: 'dec-s2' } })
const after = (await callRpc('get-reminders', { since: 0 })).reminders.length
check('决策提醒：20s 节流内不重复', after === before, `before=${before} after=${after}`)

for (const off of disposers.splice(0)) { try { off() } catch (e) {} }

// ---------- 场景 4：状态写入持久化（schedulePersist 落盘） ----------
const copyFile4 = join(work, 'index4.mjs')
writeFileSync(copyFile4, mod, 'utf8')
writeFileSync(STATE, JSON.stringify({ records: [], configs: {}, dismissed: [], tasks: {}, history: {}, defaults: {} }, null, 2))

const mod4 = await import(pathToFileURL(copyFile4).href)
const ctx4 = makeCtx()
agentRoots = [{ id: 'write-s1' }, { id: 'write-s2' }]
mod4.apply(ctx4)
await new Promise((r) => setTimeout(r, 300))

// 配置一个会话 + 跳过另一个
await callRpc('set-session-config', { sessionId: 'write-s1', taskName: '写入测试', plannedMinutes: 15, reminderIntervalMinutes: 8 })
await callRpc('dismiss-session-setup', { sessionId: 'write-s2' })
await new Promise((r) => setTimeout(r, 1200)) // 等防抖 800ms 落盘

const written = JSON.parse(readFileSync(STATE, 'utf8'))
check('写入：configs 已落盘', written.configs && written.configs['write-s1'] && written.configs['write-s1'].configured === true, written.configs)
check('写入：dismissed 已落盘', Array.isArray(written.dismissed) && written.dismissed.includes('write-s2'), written.dismissed)

// 模拟第三个实例重启加载刚写入的状态
const copyFile5 = join(work, 'index5.mjs')
writeFileSync(copyFile5, mod, 'utf8')
const mod5 = await import(pathToFileURL(copyFile5).href)
const ctx5 = makeCtx()
mod5.apply(ctx5)
await new Promise((r) => setTimeout(r, 300))
const pendWrite1 = await callRpc('get-pending-setup', { sessionId: 'write-s1' })
const pendWrite2 = await callRpc('get-pending-setup', { sessionId: 'write-s2' })
check('重载：已配置会话不弹窗', pendWrite1.pending === false, pendWrite1)
check('重载：已跳过会话不弹窗', pendWrite2.pending === false, pendWrite2)
const cfgReload = await callRpc('get-session-config', { sessionId: 'write-s1' })
check('重载：配置值恢复（15 分钟 / 8 分钟）', cfgReload.plannedMinutes === 15 && cfgReload.reminderIntervalMinutes === 8, cfgReload)

for (const off of disposers.splice(0)) { try { off() } catch (e) {} }

// ---------- 场景 5：孤儿任务清理（已删除会话不再显示"进行中"） ----------
const copyFile6 = join(work, 'index6.mjs')
writeFileSync(copyFile6, mod, 'utf8')
writeFileSync(STATE, JSON.stringify({
  records: [],
  defaults: { reminderIntervalMinutes: 10, externalAlert: false },
  configs: {
    'orphan-s1': { taskName: '孤儿运行中', plannedMinutes: 60, externalAlert: false, configured: true },
    'orphan-s2': { taskName: '孤儿空任务', plannedMinutes: null, externalAlert: false, configured: false },
  },
  dismissed: [],
  tasks: {
    // 会话已删除但任务还在 running（agent/disposed 没触发）→ tick 应静默收尾
    'orphan-s1': { sessionId: 'orphan-s1', startedAt: Date.now() - 120000, accumulatedMs: 60000, running: true, waitingDecision: false, lastResumeAt: Date.now() - 30000, lastPauseAt: null, plannedMs: 3600000, taskName: '孤儿运行中', remindersFired: 0, overdueFired: false, lastSummary: null },
    // 会话已删除、任务从未启动 → tick 应清除残留条目
    'orphan-s2': { sessionId: 'orphan-s2', startedAt: null, accumulatedMs: 0, running: false, waitingDecision: false, lastResumeAt: null, lastPauseAt: null, plannedMs: null, taskName: null, remindersFired: 0, overdueFired: false, lastSummary: null },
    // 仍在线的会话 → 不应被清理
    'live-s1': { sessionId: 'live-s1', startedAt: Date.now() - 5000, accumulatedMs: 1000, running: true, waitingDecision: false, lastResumeAt: Date.now() - 1000, lastPauseAt: null, plannedMs: 3600000, taskName: '在线任务', remindersFired: 0, overdueFired: false, lastSummary: null },
  },
  history: {},
}, null, 2))

const mod6 = await import(pathToFileURL(copyFile6).href)
const ctx6 = makeCtx()
// 只有 live-s1 还在线
agentRoots = [{ id: 'live-s1' }]
mod6.apply(ctx6)
await new Promise((r) => setTimeout(r, 300))

// 等 tick 清理执行（3s tick）
await new Promise((r) => setTimeout(r, 3500))

const board6 = await callRpc('get-task-board', {})
const active6 = board6.active || []
check('孤儿清理：已删除 running 任务不再显示 active', !active6.some((a) => a.sessionId === 'orphan-s1'), active6)
check('孤儿清理：已删除空任务不再显示 active', !active6.some((a) => a.sessionId === 'orphan-s2'), active6)
check('孤儿清理：在线会话任务保留', active6.some((a) => a.sessionId === 'live-s1' && a.running === true), active6)
check('孤儿清理：收尾计入 finished 记录', (board6.finished || []).some((r) => r.sessionId === 'orphan-s1'), board6.finished)
check('孤儿清理：收尾用时正确（已累计 60s，停机不计时）', (board6.finished || []).some((r) => r.sessionId === 'orphan-s1' && r.actualMs >= 60000 && r.actualMs < 90000), board6.finished)

// 再次重启模拟：孤儿已收尾且持久化，不再恢复
for (const off of disposers.splice(0)) { try { off() } catch (e) {} }
const copyFile7 = join(work, 'index7.mjs')
writeFileSync(copyFile7, mod, 'utf8')
agentRoots = [{ id: 'live-s1' }]
const mod7 = await import(pathToFileURL(copyFile7).href)
const ctx7 = makeCtx()
mod7.apply(ctx7)
await new Promise((r) => setTimeout(r, 300))
const board7 = await callRpc('get-task-board', {})
check('孤儿清理：重启后不再恢复孤儿任务', !(board7.active || []).some((a) => a.sessionId === 'orphan-s1'), board7.active)
check('孤儿清理：重启后 finished 记录仍在', (board7.finished || []).some((r) => r.sessionId === 'orphan-s1'), board7.finished)

for (const off of disposers.splice(0)) { try { off() } catch (e) {} }

// ---------- 清理 ----------
try { rmSync(work, { recursive: true, force: true }) } catch (e) {}

// ---------- 输出 ----------
console.log('=== dsh-task-time 自动验证结果 ===')
for (const r of results) {
  console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.pass ? '' : '  →  ' + r.detail}`)
}
console.log(failures === 0 ? '全部通过' : `失败 ${failures} 项`)
process.exit(failures === 0 ? 0 : 1)
