// dsh-task-time — Host 端
// 持久化插件（profile bundle，host 平面单实例）：计时、提醒、决策提醒、任务面板、
// 记录持久化。client 通过 HTTP 路由与 host 通信（webServer /api/dsh-task-time/rpc）。
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { existsSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'

export const name = 'dsh-task-time'
export const inject = ['webServer', 'tools', 'systemPrompt']

const defaults = { reminderIntervalMinutes: 10, externalAlert: true }
const RECORDS_FILE = join(homedir(), '.dsh', 'dsh-task-time-records.json')
const RPC_PATH = '/api/dsh-task-time/rpc'
const MAX_RECORDS = 500

export function apply(ctx) {
  const configs = new Map()
  const pendingSetup = new Map()
  const dismissedSetup = new Map()
  const tasks = new Map()
  const history = new Map()
  let reminderSeq = 0
  const reminders = []
  const decisionAlerts = new Map()

  let finishedRecords = []
  let recordFilePath = RECORDS_FILE
  let persistDiagnostic = 'idle'

  // ---------- helpers ----------
  function fmtClock(ms) {
    const total = Math.max(0, Math.floor((ms || 0) / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h > 0 ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0')
  }
  function fmtMin(ms) {
    const total = Math.max(0, Math.round((ms || 0) / 60000))
    const h = Math.floor(total / 60)
    const m = total % 60
    return h > 0 ? h + ' 小时 ' + m + ' 分钟' : m + ' 分钟'
  }

  function currentElapsed(t, now) {
    let base = t.accumulatedMs || 0
    if (t.running && t.lastResumeAt) base += Math.max(0, now - t.lastResumeAt)
    return base
  }

  // ---------- persistence ----------
  // 持久化完整状态：记录(records)、会话配置(configs，含 configured 标记)、
  // 跳过列表(dismissed)、进行中任务(tasks)、会话历史(history)。
  // 重启后恢复，保证：任务记录不丢、已配置/已跳过的会话不再弹设置窗、运行中任务续计。
  let loadPromise = null
  async function ensureLoaded() {
    if (loadPromise) return loadPromise
    loadPromise = (async () => {
      try {
        // 旧动态插件记录文件可能的位置（按优先级尝试）
        const legacyCandidates = [
          join(homedir(), 'deepseek', 'task-records.json'),
          'D:\\Project\\deepseek\\task-records.json',
          join(homedir(), 'dsh-task-time-records.json'),
        ]
        if (existsSync(RECORDS_FILE)) {
          const data = JSON.parse(await readFile(RECORDS_FILE, 'utf8'))
          if (data && Array.isArray(data.records)) finishedRecords = data.records
          if (data && typeof data.defaults === 'object' && data.defaults !== null) {
            if (Number.isFinite(data.defaults.reminderIntervalMinutes)) defaults.reminderIntervalMinutes = data.defaults.reminderIntervalMinutes
            if (typeof data.defaults.externalAlert === 'boolean') defaults.externalAlert = data.defaults.externalAlert
          }
          if (data && typeof data.configs === 'object' && data.configs !== null) {
            for (const [sid, c] of Object.entries(data.configs)) {
              if (c && typeof c === 'object') {
                const restored = { ...defaults, ...c }
                if (typeof restored.configured !== 'boolean') restored.configured = false
                configs.set(sid, restored)
              }
            }
          }
          if (data && Array.isArray(data.dismissed)) {
            for (const sid of data.dismissed) dismissedSetup.set(sid, true)
          }
          if (data && typeof data.tasks === 'object' && data.tasks !== null) {
            for (const [sid, t] of Object.entries(data.tasks)) {
              if (t && typeof t === 'object') {
                // 重启后运行中任务从"现在"续计，避免把停机时间计入任务用时
                if (t.running) {
                  t.lastResumeAt = Date.now()
                }
                tasks.set(sid, { ...t })
              }
            }
          }
          if (data && typeof data.history === 'object' && data.history !== null) {
            for (const [sid, list] of Object.entries(data.history)) {
              if (Array.isArray(list)) history.set(sid, list)
            }
          }
          // 首次加载：合并旧动态插件的记录文件（若存在且有数据）
          if (data.records === undefined || (Array.isArray(data.records) && data.records.length === 0)) {
            try {
              for (const legacyFile of legacyCandidates) {
                if (!existsSync(legacyFile)) continue
                const legacy = JSON.parse(await readFile(legacyFile, 'utf8'))
                if (legacy && Array.isArray(legacy.records) && legacy.records.length > 0) {
                  finishedRecords = legacy.records.slice(-MAX_RECORDS)
                  break
                }
              }
            } catch (e) {}
          }
          persistDiagnostic = 'loaded-from-file'
        } else {
          // 新文件：直接迁移旧动态插件记录（若存在）
          try {
            for (const legacyFile of legacyCandidates) {
              if (!existsSync(legacyFile)) continue
              const legacy = JSON.parse(await readFile(legacyFile, 'utf8'))
              if (legacy && Array.isArray(legacy.records) && legacy.records.length > 0) {
                finishedRecords = legacy.records.slice(-MAX_RECORDS)
                break
              }
            }
          } catch (e) {}
          await persistRecords()
          persistDiagnostic = 'created-empty-file'
        }
      } catch (e) {
        persistDiagnostic = 'fs-error: ' + String((e && e.message) || e)
      }
    })()
    return loadPromise
  }

  // 防抖持久化：多次变更合并为一次写入
  let persistTimer = null
  function schedulePersist() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persistRecords()
    }, 800)
  }

  async function persistRecords() {
    try {
      await mkdir(dirname(RECORDS_FILE), { recursive: true })
      const payload = {
        records: finishedRecords,
        configs: Object.fromEntries(configs),
        dismissed: [...dismissedSetup.keys()],
        tasks: Object.fromEntries(tasks),
        history: Object.fromEntries(history),
        defaults,
      }
      const tmp = RECORDS_FILE + '.' + process.pid + '.' + Date.now().toString(36) + '.tmp'
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
      await rename(tmp, RECORDS_FILE)
    } catch (e) {
      persistDiagnostic = 'persist-error: ' + String((e && e.message) || e)
    }
  }

  // ---------- agent / session helpers ----------
  const agentsSvc = ctx.get('agents')
  const sidOf = (agent) => {
    if (!agent) return undefined
    if (agent.id) return agent.id
    if (agent.session && agent.session.id) return agent.session.id
    return undefined
  }
  const isRoot = (agent) => {
    const sid = sidOf(agent)
    if (!sid) return false
    if (!agentsSvc) return true
    try {
      return agentsSvc.roots().some((a) => sidOf(a) === sid)
    } catch (e) {
      return true
    }
  }
  const getCfg = (sessionId) => {
    let c = configs.get(sessionId)
    if (!c) {
      c = {
        taskName: null,
        plannedMinutes: null,
        reminderIntervalMinutes: defaults.reminderIntervalMinutes,
        externalAlert: defaults.externalAlert,
        configured: false,
      }
      configs.set(sessionId, c)
    }
    return c
  }

  function taskNameOf(sessionId) {
    const c = configs.get(sessionId)
    if (c && c.taskName) return c.taskName
    const p = pendingSetup.get(sessionId)
    if (p && p.taskName) return p.taskName
    return null
  }

  function ensureTask(sessionId) {
    let t = tasks.get(sessionId)
    if (!t) {
      t = {
        sessionId,
        startedAt: null,
        accumulatedMs: 0,
        running: false,
        waitingDecision: false,
        lastResumeAt: null,
        lastPauseAt: null,
        plannedMs: null,
        taskName: taskNameOf(sessionId),
        remindersFired: 0,
        overdueFired: false,
        lastSummary: null,
      }
      tasks.set(sessionId, t)
    }
    return t
  }

  function finishTask(sessionId) {
    const t = tasks.get(sessionId)
    if (!t || t.startedAt === null) return
    const now = Date.now()
    if (t.running) {
      if (t.lastResumeAt !== null) {
        t.accumulatedMs += now - t.lastResumeAt
        t.lastResumeAt = null
      }
      t.running = false
    }
    const actualMs = t.accumulatedMs
    const diffMs = t.plannedMs ? actualMs - t.plannedMs : null
    t.lastSummary = { plannedMs: t.plannedMs, actualMs, diffMs }
    let diff = ''
    if (diffMs !== null) {
      diff = diffMs > 0 ? '，超出计划 ' + fmtMin(diffMs) : diffMs < 0 ? '，提前 ' + fmtMin(-diffMs) : '，与计划一致'
    }
    const base = '累计实际用时 ' + fmtMin(actualMs)
    const plan = t.plannedMs ? '计划 ' + fmtMin(t.plannedMs) : '计划未设置'
    pushReminder('finish', sessionId, '✅ 任务结束：' + base + '，' + plan + diff)
    const c = getCfg(sessionId)
    const rec = {
      sessionId,
      taskName: c.taskName || taskNameOf(sessionId),
      startedAt: new Date(t.startedAt).toISOString(),
      finishedAt: new Date(now).toISOString(),
      plannedMs: t.plannedMs || 0,
      actualMs,
      diffMs,
    }
    finishedRecords.push(rec)
    if (finishedRecords.length > MAX_RECORDS) finishedRecords = finishedRecords.slice(-MAX_RECORDS)
    let list = history.get(sessionId) || []
    list.push(rec)
    if (list.length > 50) list = list.slice(-50)
    history.set(sessionId, list)
    t.startedAt = null
    t.accumulatedMs = 0
    t.remindersFired = 0
    t.overdueFired = false
    t.waitingDecision = false
    t.plannedMs = null
    t.taskName = null
    schedulePersist()
  }

  // ---------- external alert ----------
  function externalAlert(title, message) {
    try {
      const ps = [
        '[console]::beep(880, 180); Start-Sleep -Milliseconds 90; [console]::beep(1100, 220)',
      ]
      const b64 = Buffer.from(JSON.stringify({ title, message })).toString('base64')
      const toast = `
        $p=@'
${b64}
'@; $d=$p | ConvertFrom-Json
        Add-Type -AssemblyName System.Windows.Forms
        $n=New-Object System.Windows.Forms.NotifyIcon
        $n.Icon=[System.Drawing.SystemIcons]::Information
        $n.Visible=$true
        $n.BalloonTipTitle=$d.title
        $n.BalloonTipText=$d.message
        $n.ShowBalloonTip(6000)
        Start-Sleep -Milliseconds 6500
        $n.Dispose()
      `
      const script = ps.join('; ') + '; ' + toast
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
        stdio: 'ignore',
        windowsHide: true,
        detached: true,
      })
      child.unref()
    } catch (e) {}
  }

  // ---------- reminder plumbing ----------
  // 自动消散时长对齐 DSH 内置 Toast 设计（HOLD_MS=3s + FADE_MS=1s ≈ 4s）：
  // 普通提醒 4s；需要决策的提醒给稍长窗口（8s）以便阅读，但仍会自动消散。
  function pushReminder(kind, sessionId, text, opts) {
    reminderSeq += 1
    const autoMs = opts && opts.needDecision ? 8000 : 4000
    const item = {
      id: reminderSeq,
      kind,
      sessionId,
      taskName: taskNameOf(sessionId),
      text,
      ts: Date.now(),
      needDecision: !!(opts && opts.needDecision),
      autoMs,
    }
    reminders.push(item)
    if (reminders.length > 200) reminders.shift()
    return item
  }

  // ---------- event listeners ----------
  const disposers = []

  disposers.push(ctx.on('agent/created', (payload) => {
    const agent = payload && payload.agent
    if (!agent) return
    const sessionId = sidOf(agent)
    if (!sessionId) return
    ensureTask(sessionId)
    const c = getCfg(sessionId)
    if (!c.configured) {
      const p = pendingSetup.get(sessionId)
      if (!p) {
        pendingSetup.set(sessionId, {
          taskName: null,
          plannedMinutes: null,
          reminderIntervalMinutes: c.reminderIntervalMinutes,
        })
      }
    }
  }))

  disposers.push(ctx.on('agent/status', (payload) => {
    const agent = payload && payload.agent
    const status = payload && payload.status
    if (!agent || !status) return
    const sessionId = sidOf(agent)
    if (!sessionId) return
    ensureTask(sessionId)
    if (!pendingSetup.has(sessionId) && !dismissedSetup.has(sessionId)) {
      const c = getCfg(sessionId)
      if (!c.configured) {
        pendingSetup.set(sessionId, {
          taskName: null,
          plannedMinutes: null,
          reminderIntervalMinutes: c.reminderIntervalMinutes,
        })
      }
    }
    if (!isRoot(agent)) return
    const t = ensureTask(sessionId)
    if (status === 'running') {
      if (!t.running) {
        t.running = true
        t.waitingDecision = false
        if (t.startedAt === null) {
          t.startedAt = Date.now()
          t.plannedMs = (getCfg(sessionId).plannedMinutes || 0) * 60000
        }
        t.lastResumeAt = Date.now()
        schedulePersist()
      }
    } else if (status === 'idle') {
      if (t.running) {
        t.running = false
        if (t.lastResumeAt !== null) {
          t.accumulatedMs += Date.now() - t.lastResumeAt
          t.lastResumeAt = null
        }
        schedulePersist()
      }
    }
  }))

  disposers.push(ctx.on('agent/disposed', (payload) => {
    const agent = payload && payload.agent
    if (!agent || !isRoot(agent)) return
    const sessionId = sidOf(agent)
    if (!sessionId) return
    finishTask(sessionId)
  }))

  // ---------- 需要用户决策的提醒（三通道，照 notifier 已验证做法）----------
  // 用户"需要确认/选择"时通知，无论任务是否在计时。20s 节流避免刷屏。
  function notifyDecision(sessionId, msg) {
    if (!sessionId) return
    const t = ensureTask(sessionId)
    t.waitingDecision = true
    const now = Date.now()
    const prev = decisionAlerts.get(sessionId)
    if (prev && now - prev.notifiedAt <= 20000) return
    decisionAlerts.set(sessionId, { text: '需要你决策', ts: now, notifiedAt: now })
    const text = msg || '需要你确定或选择方案后才能继续：已暂停等待你的回答，若不去处理任务会一直卡住。请前往该会话查看问题并选择。'
    pushReminder('decision', sessionId, text, { needDecision: true })
    const c = getCfg(sessionId)
    if (c.externalAlert) externalAlert((c.taskName || '任务') + '：需要你决策', text)
  }

  // 通道 1：approval/request —— 需要用户批准的工具/操作（沙箱升级、审批等）
  disposers.push(ctx.on('approval/request', async (req, next) => {
    try {
      const agent = req && req.agent
      const sessionId = agent ? sidOf(agent) : undefined
      if (sessionId && isRoot(agent)) {
        const tool = req && req.toolName
        const reason = req && req.reason
        notifyDecision(sessionId, '需要你批准工具「' + (tool || '?') + '」' + (reason ? '：' + String(reason).slice(0, 120) : '') + '。请前往该会话批准或拒绝，否则任务会卡住。')
      }
    } catch (e) {}
    return next()
  }))

  // 通道 2：userQuestions 服务的 ask 方法 —— ask_user_question 提问（hook 包装，不阻断）
  function hookUserQuestions() {
    let svc
    try {
      svc = typeof ctx.get === 'function' ? ctx.get('userQuestions', false) : undefined
    } catch (e) {
      svc = undefined
    }
    if (!svc || typeof svc.ask !== 'function') return
    let original = svc.ask
    if (original && original.__dshTaskTimeWrapped === true && typeof original.__dshTaskTimeOriginal === 'function') {
      original = original.__dshTaskTimeOriginal
    }
    const callOriginal = original.bind(svc)
    const wrapped = async (request) => {
      try {
        const agent = request && request.agent
        const sessionId = agent ? sidOf(agent) : undefined
        if (sessionId && isRoot(agent)) {
          const first = Array.isArray(request && request.questions) ? request.questions[0] : undefined
          const q = first && (first.question || first.header)
          notifyDecision(sessionId, q ? '需要你回答：' + String(q).slice(0, 120) : '需要你选择方案后才能继续，请前往该会话回答。')
        }
      } catch (e) {}
      return callOriginal(request)
    }
    wrapped.__dshTaskTimeWrapped = true
    wrapped.__dshTaskTimeOriginal = callOriginal
    svc.ask = wrapped
  }
  hookUserQuestions()
  disposers.push(ctx.on('internal/service', (name) => {
    if (name === 'userQuestions') hookUserQuestions()
  }))

  // 通道 3：tools/pre-execute 兜底 —— 某些确认类工具名仍走工具分发
  disposers.push(ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      const agent = exec && exec.agent
      const sessionId = agent ? sidOf(agent) : undefined
      const name = exec && exec.name
      if (sessionId && isRoot(agent) && name && /ask_user_question|confirm|approve/i.test(String(name))) {
        notifyDecision(sessionId, '需要你确定或选择方案后才能继续：已暂停等待你的回答，若不去处理任务会一直卡住。请前往该会话查看问题并选择。')
      }
    } catch (e) {}
    return next()
  }))

  // ---------- timer: 3s tick ----------
  const tick = setInterval(() => {
    try {
      for (const [sessionId, t] of tasks) {
        if (!t.running || t.startedAt === null) continue
        const now = Date.now()
        const c = getCfg(sessionId)
        const intervalMs = (c.reminderIntervalMinutes || defaults.reminderIntervalMinutes) * 60000
        if (intervalMs <= 0) continue
        const elapsed = currentElapsed(t, now)
        const due = Math.floor(elapsed / intervalMs)
        if (due > t.remindersFired) {
          t.remindersFired = due
          const plan = t.plannedMs ? '计划 ' + fmtMin(t.plannedMs) : '计划未设置'
          const text = '🔔 第 ' + t.remindersFired + ' 次提醒：任务累计运行 ' + fmtClock(elapsed) + '（' + plan + '）。你可以发消息让 agent 汇报当前进度、判断任务是否有问题、是否应中止或继续。'
          pushReminder('interval', sessionId, text)
          if (c.externalAlert) externalAlert((c.taskName || '任务') + ' 提醒', '已持续 ' + fmtMin(elapsed) + '，' + plan)
        }
        if (t.plannedMs && elapsed >= t.plannedMs && !t.overdueFired) {
          t.overdueFired = true
          const text = '⚠️ 已超过计划用时（' + fmtMin(t.plannedMs) + '），当前累计运行 ' + fmtClock(elapsed) + '。请发消息判断是否需要中止或调整计划。'
          pushReminder('overdue', sessionId, text)
          if (c.externalAlert) externalAlert((c.taskName || '任务') + '：超时', '已超过计划用时 ' + fmtMin(t.plannedMs))
        }
      }
    } catch (e) {}
  }, 3000)

  ctx.effect(() => () => {
    clearInterval(tick)
    for (const off of disposers) {
      try { off() } catch (e) {}
    }
    // 停用前同步落盘，避免防抖窗口内的最后变更丢失
    try {
      if (persistTimer) clearTimeout(persistTimer)
      const payload = {
        records: finishedRecords,
        configs: Object.fromEntries(configs),
        dismissed: [...dismissedSetup.keys()],
        tasks: Object.fromEntries(tasks),
        history: Object.fromEntries(history),
        defaults,
      }
      const f = join(homedir(), '.dsh', 'dsh-task-time-records.json')
      mkdirSync(dirname(f), { recursive: true })
      const tmp = f + '.exit.tmp'
      writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      renameSync(tmp, f)
    } catch (e) {}
  }, 'dsh-task-time')

  // ---------- HTTP RPC ----------
  const handlers = {
    'get-pending-setup': (args) => {
      const sessionId = String(args && args.sessionId || '')
      let p = pendingSetup.get(sessionId)
      if (!p && !dismissedSetup.has(sessionId)) {
        const c = getCfg(sessionId)
        if (!c.configured) {
          p = { taskName: null, plannedMinutes: null, reminderIntervalMinutes: c.reminderIntervalMinutes }
          pendingSetup.set(sessionId, p)
        }
      }
      return { pending: !!p, taskName: p ? p.taskName : null, plannedMinutes: p ? p.plannedMinutes : null, reminderIntervalMinutes: p ? p.reminderIntervalMinutes : defaults.reminderIntervalMinutes }
    },
    'get-pending-sessions': (args) => {
      const agentsSvc = ctx.get('agents')
      if (agentsSvc) {
        try {
          for (const a of agentsSvc.roots()) {
            const sid = sidOf(a)
            if (!sid) continue
            ensureTask(sid)
            if (!pendingSetup.has(sid) && !dismissedSetup.has(sid)) {
              const c = getCfg(sid)
              if (!c.configured) {
                pendingSetup.set(sid, {
                  taskName: null,
                  plannedMinutes: null,
                  reminderIntervalMinutes: c.reminderIntervalMinutes,
                })
              }
            }
          }
        } catch (e) {}
      }
      const list = []
      for (const [sid, p] of pendingSetup) {
        list.push({ sessionId: sid, taskName: p.taskName, plannedMinutes: p.plannedMinutes, reminderIntervalMinutes: p.reminderIntervalMinutes })
      }
      return { sessions: list }
    },
    'get-status': (args) => {
      const sessionId = String(args && args.sessionId || '')
      const t = tasks.get(sessionId)
      const c = getCfg(sessionId)
      if (!t || t.startedAt === null) {
        return {
          active: false,
          taskName: taskNameOf(sessionId),
          running: false,
          waitingDecision: false,
          elapsedMs: 0,
          plannedMs: 0,
          remindersFired: 0,
          lastSummary: t ? t.lastSummary : null,
        }
      }
      const now = Date.now()
      const elapsed = currentElapsed(t, now)
      return {
        active: true,
        taskName: c.taskName || taskNameOf(sessionId),
        running: t.running,
        waitingDecision: t.waitingDecision,
        plannedMinutes: c.plannedMinutes,
        plannedMs: t.plannedMs || 0,
        elapsedMs: elapsed,
        remindersFired: t.remindersFired,
        lastSummary: t.lastSummary,
        startedAt: t.startedAt,
      }
    },
    'get-reminders': (args) => {
      const since = Number(args && args.since) || 0
      const fresh = reminders.filter((r) => r.id > since)
      return { reminders: fresh.map((r) => ({ id: r.id, kind: r.kind, sessionId: r.sessionId, taskName: r.taskName, text: r.text, ts: r.ts, needDecision: r.needDecision, autoMs: r.autoMs })), maxId: reminders.length ? reminders[reminders.length - 1].id : since }
    },
    'get-external-status': () => ({ available: true, file: recordFilePath, diagnostic: persistDiagnostic }),
    'get-config': () => ({ ...defaults }),
    'set-config': (args) => {
      const cfg = args && args.config || {}
      defaults.reminderIntervalMinutes = Number.isFinite(cfg.reminderIntervalMinutes) ? cfg.reminderIntervalMinutes : defaults.reminderIntervalMinutes
      defaults.externalAlert = typeof cfg.externalAlert === 'boolean' ? cfg.externalAlert : defaults.externalAlert
      schedulePersist()
      return { ok: true, ...defaults }
    },
    'get-session-config': (args) => {
      const sessionId = String(args && args.sessionId || '')
      const c = getCfg(sessionId)
      return { taskName: c.taskName, plannedMinutes: c.plannedMinutes, reminderIntervalMinutes: c.reminderIntervalMinutes, externalAlert: c.externalAlert }
    },
    'set-session-config': (args) => {
      const sessionId = String(args && args.sessionId || '')
      const c = getCfg(sessionId)
      if (args && typeof args.taskName === 'string') c.taskName = args.taskName
      if (Number.isFinite(args && args.plannedMinutes)) c.plannedMinutes = args.plannedMinutes
      if (Number.isFinite(args && args.reminderIntervalMinutes)) c.reminderIntervalMinutes = args.reminderIntervalMinutes
      if (typeof (args && args.externalAlert) === 'boolean') c.externalAlert = args.externalAlert
      c.configured = true
      pendingSetup.delete(sessionId)
      dismissedSetup.delete(sessionId)
      const t = ensureTask(sessionId)
      t.taskName = c.taskName
      t.plannedMs = (c.plannedMinutes || 0) * 60000
      t.overdueFired = false
      if (t.plannedMs > 0 && t.startedAt === null) t.startedAt = Date.now()
      const msg = '✅ 新会话设置完成：任务「' + (c.taskName || '未命名任务') + '」计划用时 ' + c.plannedMinutes + ' 分钟，提醒间隔 ' + c.reminderIntervalMinutes + ' 分钟（按累计运行计时）。任务可以开始了。'
      pushReminder('setup', sessionId, msg)
      schedulePersist()
      return { ok: true }
    },
    'dismiss-session-setup': (args) => {
      const sessionId = String(args && args.sessionId || '')
      pendingSetup.delete(sessionId)
      dismissedSetup.set(sessionId, true)
      schedulePersist()
      return { ok: true }
    },
    'get-history': (args) => {
      const sessionId = String(args && args.sessionId || '')
      const list = history.get(sessionId) || []
      return { records: list }
    },
    'get-task-board': async () => {
      await ensureLoaded()
      const now = Date.now()
      const active = []
      for (const [sid, t] of tasks) {
        if (t.startedAt === null) continue
        active.push({
          sessionId: sid,
          taskName: taskNameOf(sid),
          running: t.running,
          waitingDecision: t.waitingDecision,
          startedAt: new Date(t.startedAt).toISOString(),
          plannedMs: t.plannedMs || 0,
          elapsedMs: currentElapsed(t, now),
          remindersFired: t.remindersFired,
        })
      }
      active.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
      const finished = [...finishedRecords].sort((a, b) => (a.finishedAt < b.finishedAt ? -1 : 1))
      return { active, finished, file: recordFilePath, diagnostic: persistDiagnostic }
    },
    'clear-task-records': async () => {
      await ensureLoaded()
      finishedRecords = []
      await persistRecords()
      return { ok: true }
    },
  }

  const route = {
    kind: 'exact',
    path: RPC_PATH,
    handler: async (req, res) => {
      try {
        const body = await readBody(req, 128 * 1024)
        const method = body && typeof body.method === 'string' ? body.method : null
        const args = body && body.args !== undefined ? body.args : {}
        const fn = method ? handlers[method] : undefined
        if (!fn) {
          writeJson(res, 404, { error: 'unknown method: ' + String(method) })
          return
        }
        const result = await fn(args)
        writeJson(res, 200, { ok: true, data: result })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    },
  }
  const disposeRoute = ctx.webServer.register(route)
  ctx.effect(() => () => {
    try { disposeRoute() } catch (e) {}
  }, 'dsh-task-time:routes')

  // ---------- tool: task_plan_set ----------
  const disposeTool = ctx.tools.register({
    name: 'task_plan_set',
    description: '设置本次任务的计划用时（分钟）。会话创建时用户已在独立窗口设置默认计划；此工具用于运行中调整当前任务的计划用时。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        plannedMinutes: { type: 'number', description: '本次任务的计划用时，单位：分钟，至少 1 分钟' },
        note: { type: 'string', description: '任务备注（可选）' },
      },
      required: ['plannedMinutes'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok'],
      },
      render: (_args, value) => [{ type: 'text', text: value && value.message }],
    },
    async execute(args, exec) {
      const agent = exec && exec.agent
      const sessionId = agent ? sidOf(agent) : undefined
      const minutes = Math.max(1, Math.round(Number(args && args.plannedMinutes) || 0))
      if (!sessionId) return { ok: false, message: '无法识别当前会话，请重试。' }
      if (!minutes) return { ok: false, message: '计划用时必须是一个正数分钟。' }
      const c = getCfg(sessionId)
      c.plannedMinutes = minutes
      c.configured = true
      pendingSetup.delete(sessionId)
      dismissedSetup.delete(sessionId)
      const t = ensureTask(sessionId)
      t.plannedMs = minutes * 60000
      t.overdueFired = false
      if (t.startedAt === null) t.startedAt = Date.now()
      const msg = '✅ 已设置本次任务计划用时 ' + minutes + ' 分钟。每隔 ' + c.reminderIntervalMinutes + ' 分钟（累计运行）提醒一次；任务结束时会统计累计实际用时与计划的差距。'
      pushReminder('tool', sessionId, msg)
      schedulePersist()
      return { ok: true, message: msg }
    },
  })
  ctx.effect(() => () => {
    try { disposeTool() } catch (e) {}
  }, 'dsh-task-time:tool')

  // ---------- prompt section ----------
  const disposeSection = ctx.systemPrompt.section({
    name: 'task-time',
    order: 220,
    text: '## 任务用时管理\n\n会话创建时，用户会在独立窗口中填写任务名并设置本次任务的计划用时与提醒间隔（也可直接关闭跳过设置）。若会话尚未设置计划用时，请先提醒用户完成设置（或调用 `task_plan_set` 调整）。计时为连续累计：只有模型运行时才计时，暂停（等待用户输入）不计时，恢复后接着累计。任务进行中按累计运行间隔提醒（含系统提示音与桌面通知，提醒会标明任务名，界面提醒卡会在一段时间后自动消散）；当插件检测到你在等待用户确定或选择方案时，会提醒用户避免任务卡住；任务结束时自动统计累计实际用时与计划用时的差距，并写入任务记录文件。',
  })
  ctx.effect(() => () => {
    try { disposeSection() } catch (e) {}
  }, 'dsh-task-time:prompt')

  void ensureLoaded()
}

// ---------- helpers ----------
function writeJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  res.end(JSON.stringify(payload))
}

function readBody(req, limit) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise(text.length === 0 ? {} : JSON.parse(text))
      } catch (e) {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}