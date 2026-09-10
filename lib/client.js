// dsh-task-time — Client bundle（持久化 profile 插件）
// 浏览器端 UI：composer.dock 计时状态条 + 设置弹窗、shell.overlay 提醒卡/任务面板、
// settings.section 设置页。通信走 HTTP RPC（/api/dsh-task-time/rpc）。
"use strict";
(() => {
  // ---------- CSS ----------
  var style_default = `
  .tt-stack {
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 10px;
    pointer-events: none;
  }
  .tt-reminder {
    pointer-events: auto;
    max-width: 360px;
    width: 340px;
    background: #1f2430;
    color: #e6e6e6;
    border: 1px solid #3a4152;
    border-left: 3px solid #eab308;
    border-radius: 8px;
    padding: 10px 12px;
    box-shadow: 0 6px 24px rgba(0,0,0,.35);
    font-size: 13px;
    line-height: 1.5;
    opacity: 1;
    transition: opacity .4s ease;
  }
  .tt-reminder.tt-need-decision { border-left-color: #f87171; }
  .tt-reminder.tt-need-decision .tt-reminder-head { color: #f87171; }
  .tt-reminder.tt-fading { opacity: 0; transition: opacity 1s ease; pointer-events: none; }
  .tt-reminder-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-weight: 600;
    margin-bottom: 4px;
    color: #eab308;
  }
  .tt-reminder-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tt-reminder-body { word-break: break-word; }
  .tt-reminder-close {
    background: none;
    border: none;
    color: #8a90a0;
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0 2px;
    flex-shrink: 0;
  }
  .tt-reminder-close:hover { color: #fff; }
  .tt-strip {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #8a90a0;
    padding: 2px 0;
  }
  .tt-strip .tt-name { color: #c9cdd6; font-weight: 600; }
  .tt-strip .tt-active { color: #eab308; }
  .tt-strip .tt-paused { color: #60a5fa; }
  .tt-strip .tt-done { color: #4ade80; }
  .tt-strip .tt-need { color: #f87171; }
  .tt-board-btn {
    position: fixed;
    left: 20px;
    bottom: 20px;
    z-index: 9998;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid #3a4152;
    background: #1f2430;
    color: #e8e8e8;
    cursor: pointer;
    font-size: 13px;
    box-shadow: 0 4px 16px rgba(0,0,0,.35);
  }
  .tt-board-btn:hover { filter: brightness(1.15); }
  .tt-board-backdrop {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 9997;
    background: transparent;
  }
  .tt-board {
    position: fixed;
    left: 20px;
    bottom: 64px;
    z-index: 9998;
    width: 480px;
    max-width: calc(100vw - 40px);
    max-height: calc(100vh - 120px);
    display: flex;
    flex-direction: column;
    background: #1c2029;
    color: #e8e8e8;
    border: 1px solid #3a4152;
    border-radius: 12px;
    box-shadow: 0 12px 48px rgba(0,0,0,.5);
    font-size: 13px;
    overflow: hidden;
  }
  .tt-board-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #2a3040;
    font-weight: 600;
    font-size: 14px;
  }
  .tt-board-head .tt-close {
    background: none;
    border: none;
    color: #8a90a0;
    cursor: pointer;
    font-size: 18px;
    line-height: 1;
  }
  .tt-board-head .tt-close:hover { color: #fff; }
  .tt-board-body { overflow-y: auto; padding: 12px 16px; }
  .tt-board-sec { margin: 6px 0 4px; color: #9aa0b0; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .tt-board-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 0;
    border-bottom: 1px solid #242a38;
    cursor: pointer;
    border-radius: 6px;
  }
  .tt-board-item:hover { background: #232a38; }
  .tt-board-item:last-child { border-bottom: none; }
  .tt-board-item .tt-bi-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: #e8e8e8; }
  .tt-board-item .tt-bi-name-wrap { flex: 1; min-width: 0; font-weight: 600; color: #e8e8e8; white-space: normal; word-break: break-word; line-height: 1.35; }
  .tt-board-item .tt-bi-meta { color: #9aa0b0; font-size: 12px; }
  .tt-board-item .tt-bi-tag { flex-shrink: 0; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .tt-board-item .tt-bi-go { flex-shrink: 0; color: #6a7080; font-size: 12px; }
  .tt-board-item:hover .tt-bi-go { color: #eab308; }
  .tt-board-item .tt-bi-del {
    flex-shrink: 0;
    background: none;
    border: none;
    color: #6a7080;
    cursor: pointer;
    font-size: 13px;
    line-height: 1;
    padding: 2px 4px;
    border-radius: 4px;
  }
  .tt-board-item .tt-bi-del:hover { color: #f87171; background: rgba(248,113,113,.12); }
  .tt-bi-closed { flex-shrink: 0; color: #6a7080; font-size: 11px; }
  .tt-bi-active { color: #eab308; }
  .tt-bi-paused { color: #60a5fa; }
  .tt-bi-wait { color: #f87171; }
  .tt-bi-done { color: #4ade80; }
  .tt-bi-over { color: #fb923c; }
  .tt-board-empty { color: #6a7080; font-size: 12px; padding: 8px 0; }
  .tt-board-foot { padding: 8px 16px; border-top: 1px solid #2a3040; color: #6a7080; font-size: 11px; }
  .tt-setup {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 9500;
    background: rgba(10,12,16,.6);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: auto;
  }
  .tt-setup-card {
    width: min(380px, calc(100vw - 40px));
    background: #1f2430;
    color: #e6e6e6;
    border: 1px solid #3a4152;
    border-radius: 12px;
    padding: 18px;
    box-shadow: 0 12px 40px rgba(0,0,0,.5);
    font-size: 13px;
  }
  .tt-setup-card h3 { margin: 0 0 12px; font-size: 15px; color: #eab308; }
  .tt-setup-field { margin-bottom: 12px; }
  .tt-setup-field label { display: block; margin-bottom: 4px; color: #8a90a0; font-size: 12px; }
  .tt-setup-field input {
    width: 100%;
    box-sizing: border-box;
    background: #14171f;
    color: #e6e6e6;
    border: 1px solid #3a4152;
    border-radius: 6px;
    padding: 7px 9px;
    font-size: 13px;
  }
  .tt-setup-actions { display: flex; gap: 8px; margin-top: 14px; }
  .tt-setup-actions button {
    flex: 1;
    border: none;
    border-radius: 6px;
    padding: 8px 10px;
    font-size: 13px;
    cursor: pointer;
  }
  .tt-setup-start { background: #eab308; color: #1f2430; font-weight: 600; }
  .tt-setup-skip { background: #2a2f3d; color: #8a90a0; }
  .tt-setup-note { margin-top: 10px; color: #5b6472; font-size: 11px; line-height: 1.5; }
  .tt-settings { padding: 4px 0; }
  .tt-settings .tt-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid var(--dsw-alias-border-l1, #e2e5ea);
  }
  .tt-settings label { font-size: 13px; }
  .tt-settings input[type="number"] {
    width: 90px;
    padding: 5px 8px;
    border: 1px solid var(--dsw-alias-border-l1, #e2e5ea);
    border-radius: 6px;
    font-size: 13px;
  }
  .tt-settings .tt-hint { color: var(--dsw-alias-label-tertiary, #8a919c); font-size: 11px; margin-top: 10px; }
  `;

  function injectStyle() {
    var id = "dsh-task-time-style";
    if (document.getElementById(id)) return;
    var el = document.createElement("style");
    el.id = id;
    el.textContent = style_default;
    (document.head || document.documentElement).appendChild(el);
  }

  // ---------- HTTP RPC ----------
  var RPC = "/api/dsh-task-time/rpc";
  function rpc(method, args) {
    return fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: method, args: args || {} }),
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) return d.data;
        var err = new Error((d && d.error) || "rpc failed: " + method);
        throw err;
      });
  }

  // ---------- React (injected via ModuleLoader factory below) ----------
  var React = null;

  // ---------- global store ----------
  var store = {
    reminders: [],
    boardOpen: false,
    boardData: { active: [], finished: [], file: null },
  };
  var listeners = new Set();
  var _snapshot = { reminders: [], boardOpen: false, boardData: { active: [], finished: [], file: null } };

  function subscribe(fn) {
    listeners.add(fn);
    return function () { listeners.delete(fn); };
  }
  function getSnapshot() {
    return _snapshot;
  }
  function emitChange() {
    _snapshot = { reminders: store.reminders, boardOpen: store.boardOpen, boardData: store.boardData };
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }
  function getSnapshot() {
    return _snapshot;
  }

  function fmtClock(ms) {
    if (!ms || ms <= 0) return "0:00";
    var total = Math.max(0, Math.floor(ms / 1000));
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") : m + ":" + String(s).padStart(2, "0");
  }
  function fmtMin(ms) {
    if (!ms || ms <= 0) return "0 分钟";
    var total = Math.max(0, Math.round(ms / 60000));
    var h = Math.floor(total / 60);
    var m = total % 60;
    return h > 0 ? h + " 小时 " + m + " 分钟" : m + " 分钟";
  }
  function fmtDate(iso) {
    try {
      var d = new Date(iso);
      var p = function (n) { return String(n).padStart(2, "0"); };
      return (d.getMonth() + 1) + "-" + d.getDate() + " " + p(d.getHours()) + ":" + p(d.getMinutes());
    } catch (e) { return ""; }
  }
  var sessionsSvc = null;

  // ---------- reminder store ops ----------
  // 自动消散对齐 DSH 内置 Toast（HOLD_MS=3s + FADE_MS=1s ≈ 4s）：
  // host 传入 autoMs 为全透明保持时长，client 在此之上加 1s 淡出后再移除。
  var FADE_MS = 1000;
  var reminderTimers = new Map();
  var fadingIds = new Set();

  function dismissReminder(id) {
    // 若正在淡出中再次触发，直接移除
    var t = reminderTimers.get(id);
    if (t) { clearTimeout(t); reminderTimers.delete(id); }
    fadingIds.delete(id);
    store.reminders = store.reminders.filter(function (r) { return r.id !== id; });
    emitChange();
  }

  function fadeOutReminder(id) {
    fadingIds.add(id);
    emitChange();
    var t = setTimeout(function () { dismissReminder(id); }, FADE_MS);
    reminderTimers.set(id, t);
  }

  function pushReminder(r) {
    var existing = reminderTimers.get(r.id);
    if (existing) clearTimeout(existing);
    fadingIds.delete(r.id);
    store.reminders = [r].concat(store.reminders.filter(function (x) { return x.id !== r.id; }));
    if (store.reminders.length > 8) store.reminders = store.reminders.slice(0, 8);
    var holdMs = r.autoMs || 4000;
    var timer = setTimeout(function () { fadeOutReminder(r.id); }, holdMs);
    reminderTimers.set(r.id, timer);
    emitChange();
  }

  // ---------- ReminderStack ----------
  function ReminderStack() {
    var snap = React.useSyncExternalStore(subscribe, getSnapshot);
    var items = snap.reminders || [];
    if (items.length === 0) return null;
    return React.createElement("div", { className: "tt-stack" },
      items.map(function (r) {
        var cls = "tt-reminder" + (r.needDecision ? " tt-need-decision" : "") + (fadingIds.has(r.id) ? " tt-fading" : "");
        var title = r.needDecision ? "❓ " + (r.taskName || "任务") + "：需要你决策" : "⏰ " + (r.taskName || "任务提醒");
        return React.createElement("div", { key: String(r.id), className: cls },
          React.createElement("div", { className: "tt-reminder-head" },
            React.createElement("span", { className: "tt-reminder-title", title: title }, title),
            React.createElement("button", { className: "tt-reminder-close", onClick: function () { dismissReminder(r.id); }, title: "关闭" }, "\u00d7")
          ),
          React.createElement("div", { className: "tt-reminder-body" }, r.text)
        );
      })
    );
  }

  // ---------- TaskBoard ----------
  function TaskBoard() {
    var openState = React.useState(false);
    var open = openState[0];
    var setOpen = openState[1];
    var dataState = React.useState({ active: [], finished: [] });
    var data = dataState[0];
    var setData = dataState[1];
    function loadBoard() {
      rpc("get-task-board", {}).then(function (d) {
        setData({ active: (d && d.active) || [], finished: (d && d.finished) || [], file: (d && d.file) || null });
        setOpen(true);
      }).catch(function () {});
    }
    function goToSession(sid) {
      if (sessionsSvc && sid) {
        try { var r = sessionsSvc.open(sid); if (r && typeof r.then === 'function') { r.catch(function(){}); } } catch (e) {}
      }
      setOpen(false);
    }
    function deleteRecord(sessionId, finishedAt, ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      rpc("delete-task-record", { sessionId: sessionId, finishedAt: finishedAt }).then(function (d) {
        if (d && d.ok) {
          setData({ active: data.active, finished: (data.finished || []).filter(function (f) { return !(f.sessionId === sessionId && f.finishedAt === finishedAt); }), file: data.file });
          if (d.closedSession) {
            pushReminder({ id: -Date.now(), kind: 'deleted', taskName: '任务已删除', text: '已删除该任务记录，并关闭了对应会话。', ts: Date.now(), needDecision: false, autoMs: 6000 });
          }
        } else {
          pushReminder({ id: -Date.now(), kind: 'error', taskName: '删除失败', text: (d && d.error) || '删除失败', ts: Date.now(), needDecision: false, autoMs: 6000 });
        }
      }).catch(function (e) {
        pushReminder({ id: -Date.now(), kind: 'error', taskName: '删除失败', text: '删除失败：' + String((e && e.message) || e) + '。可能需要重启 DSH Desktop 加载新版本插件。', ts: Date.now(), needDecision: false, autoMs: 8000 });
      });
    }
    var activeRows = (data.active || []).map(function (a) {
      var tag = a.waitingDecision
        ? React.createElement("span", { className: "tt-bi-tag tt-bi-wait" }, "❓ 需决策")
        : a.running
          ? React.createElement("span", { className: "tt-bi-tag tt-bi-active" }, "运行中")
          : React.createElement("span", { className: "tt-bi-tag tt-bi-paused" }, "已暂停");
      return React.createElement("div", { key: a.sessionId, className: "tt-board-item", onClick: function () { goToSession(a.sessionId); }, title: "点击打开该任务会话" },
        React.createElement("span", { className: "tt-bi-name-wrap", title: a.taskName || "未命名任务" }, a.taskName || "未命名任务"),
        tag,
        React.createElement("span", { className: "tt-bi-meta" },
          "已用 " + fmtClock(a.elapsedMs) + (a.plannedMs ? " · 计划 " + fmtMin(a.plannedMs) : "") + " · 提醒 " + a.remindersFired + " 次"
        ),
        React.createElement("span", { className: "tt-bi-go" }, "\u2197")
      );
    });
    var finishedRows = (data.finished || []).slice().reverse().map(function (f) {
      var diffTxt = "计划未设置";
      if (f.plannedMs != null) {
        var d = (f.actualMs || 0) - f.plannedMs;
        diffTxt = d > 0 ? "超出 " + fmtMin(d) : d < 0 ? "提前 " + fmtMin(-d) : "一致";
      }
      var over = f.plannedMs != null && (f.actualMs || 0) > f.plannedMs;
      var tag = React.createElement("span", { className: "tt-bi-tag " + (over ? "tt-bi-over" : "tt-bi-done") }, over ? "超时" : "完成");
      var closedTag = f.sessionClosed ? React.createElement("span", { className: "tt-bi-closed", title: "该会话已关闭" }, "已关闭") : null;
      return React.createElement("div", { key: (f.sessionId || "") + "-" + (f.finishedAt || ""), className: "tt-board-item", onClick: function () { goToSession(f.sessionId); }, title: "点击打开该任务会话" },
        React.createElement("span", { className: "tt-bi-name-wrap", title: f.taskName || "未命名任务" }, f.taskName || "未命名任务"),
        tag,
        closedTag,
        React.createElement("span", { className: "tt-bi-meta" },
          "实际 " + fmtMin(f.actualMs || 0) + " · 计划 " + (f.plannedMs != null ? fmtMin(f.plannedMs) : "—") + " · " + diffTxt + " · " + fmtDate(f.finishedAt)
        ),
        React.createElement("button", { className: "tt-bi-del", onClick: function (ev) { deleteRecord(f.sessionId, f.finishedAt, ev); }, title: "删除该任务记录" }, "\ud83d\uddd1"),
        React.createElement("span", { className: "tt-bi-go" }, "\u2197")
      );
    });
    return React.createElement(React.Fragment, null,
      React.createElement("button", { className: "tt-board-btn", onClick: function () { if (open) { setOpen(false); } else { loadBoard(); } } }, open ? "\u2715" : "\ud83d\uddc2"),
      open ? React.createElement("div", { className: "tt-board-backdrop", onClick: function () { setOpen(false); } }) : null,
      open ? React.createElement("div", { className: "tt-board" },
        React.createElement("div", { className: "tt-board-head" },
          React.createElement("span", null, "任务面板（点击任务跳转会话）"),
          React.createElement("button", { className: "tt-close", onClick: function () { setOpen(false); } }, "\u00d7")
        ),
        React.createElement("div", { className: "tt-board-body" },
          React.createElement("div", { className: "tt-board-sec" }, "进行中 (" + (data.active || []).length + ")"),
          (data.active || []).length === 0 ? React.createElement("div", { className: "tt-board-empty" }, "暂无进行中的任务") : activeRows,
          React.createElement("div", { className: "tt-board-sec" }, "已完成 (" + (data.finished || []).length + ")"),
          (data.finished || []).length === 0 ? React.createElement("div", { className: "tt-board-empty" }, "暂无已完成的任务记录") : finishedRows
        ),
        React.createElement("div", { className: "tt-board-foot" },
          React.createElement("span", null, data.file ? "记录文件：" + data.file : "记录文件：加载中…"),
          " · ",
          React.createElement("button", { style: { border: "none", background: "none", color: "#f87171", cursor: "pointer", fontSize: 12, padding: 0 }, onClick: function () { rpc("clear-task-records", {}).then(function () { setData({ active: data.active, finished: [], file: data.file }); }).catch(function () {}); } }, "清空已完成记录")
        )
      ) : null
    );
  }

  // ---------- DockEntry (composer.dock) ----------
  // 只显示当前会话的计时状态条。设置弹窗由 SetupManager（shell.overlay）统一负责。
  function DockEntry(props) {
    var sessionId = props && props.sessionId;
    var statusState = React.useState(null);
    var status = statusState[0];
    var setStatus = statusState[1];

    React.useEffect(function () {
      if (!sessionId) return undefined;
      var alive = true;
      function refresh() {
        rpc("get-status", { sessionId: sessionId }).then(function (d) {
          if (alive) setStatus(d);
        }).catch(function () {});
      }
      refresh();
      var timer = setInterval(refresh, 2000);
      return function () { alive = false; clearInterval(timer); };
    }, [sessionId]);

    var statusEl = null;
    if (status && status.active) {
      var label = status.taskName || "未命名任务";
      var elapsed = status.elapsedMs || 0;
      var planned = status.plannedMs || 0;
      var running = !!status.running;
      var waiting = !!status.waitingDecision;
      var statusText = waiting ? React.createElement("span", { className: "tt-need" }, "❓ 需要你决策") : React.createElement("span", { className: running ? "tt-active" : "tt-paused" }, running ? "⏱ 运行中" : "⏸ 已暂停");
      statusEl = React.createElement("div", { className: "tt-strip" },
        React.createElement("span", { className: "tt-name" }, label),
        statusText,
        React.createElement("span", null, "已用 " + fmtClock(elapsed)),
        React.createElement("span", null, planned ? "计划 " + fmtMin(planned) : "计划未设置"),
        status.remindersFired > 0 ? React.createElement("span", null, "· 已提醒 " + status.remindersFired + " 次") : null
      );
    } else if (status && status.lastSummary) {
      var s = status.lastSummary;
      var diff = "";
      if (s.diffMs != null) diff = s.diffMs > 0 ? "（超时 " + fmtClock(s.diffMs) + "）" : s.diffMs < 0 ? "（提前 " + fmtClock(-s.diffMs) + "）" : "（与计划一致）";
      statusEl = React.createElement("div", { className: "tt-strip" },
        React.createElement("span", { className: "tt-done" }, "✅ 上次任务"),
        React.createElement("span", { className: "tt-name" }, status.taskName || "未命名任务"),
        React.createElement("span", null, "实际 " + fmtClock(s.actualMs)),
        React.createElement("span", null, s.plannedMs ? "vs 计划 " + fmtMin(s.plannedMs) : "计划未设置"),
        diff ? React.createElement("span", null, diff) : null
      );
    }

    return statusEl;
  }

  // ---------- SetupManager (global) ----------
  // 只针对"当前会话"检测 pending 并弹窗：用官方 API sessionsSvc.list.getSnapshot().current。
  // 点击开始/跳过 -> host 标记 configured/dismissed -> get-pending-setup 返回 pending:false -> 弹窗关闭。
  function SetupManager() {
    var setupState = React.useState(null);
    var setup = setupState[0];
    var setSetup = setupState[1];
    var taskNameState = React.useState("");
    var taskName = taskNameState[0];
    var setTaskName = taskNameState[1];
    var planState = React.useState("60");
    var plan = planState[0];
    var setPlan = planState[1];
    var intervalState = React.useState("10");
    var interval = intervalState[0];
    var setInterval = intervalState[1];

    React.useEffect(function () {
      if (!sessionsSvc || !sessionsSvc.list) return;
      var alive = true;
      var pollTimer;
      function refresh() {
        if (!alive) return;
        var currentId = null;
        try {
          var snap = sessionsSvc.list.getSnapshot();
          currentId = snap && snap.current;
        } catch (e) {}
        if (!currentId) {
          setSetup(null);
          pollTimer = setTimeout(refresh, 2000);
          return;
        }
        rpc("get-pending-setup", { sessionId: currentId }).then(function (d) {
          if (!alive) return;
          if (d && d.pending) {
            // 同一会话保持 setup 不变（不重置用户输入）；新会话初始化
            setSetup(function (prev) {
              if (prev && prev.sessionId === currentId) return prev;
              return {
                sessionId: currentId,
                taskName: d.taskName || "",
                plannedMinutes: d.plannedMinutes || null,
                reminderIntervalMinutes: d.reminderIntervalMinutes || 10,
              };
            });
          } else {
            setSetup(null);
          }
        }).catch(function () {});
        pollTimer = setTimeout(refresh, 2000);
      }
      refresh();
      return function () { alive = false; if (pollTimer) clearTimeout(pollTimer); };
    }, []);

    // 仅在 setup 的 sessionId 变化时初始化输入值（弹窗出现/切换会话时）
    React.useEffect(function () {
      if (!setup) return;
      setTaskName(setup.taskName || "");
      setPlan(String(setup.plannedMinutes || "60"));
      setInterval(String(setup.reminderIntervalMinutes || "10"));
    }, [setup ? setup.sessionId : null]);

    if (!setup) return null;
    return React.createElement("div", { className: "tt-setup" },
      React.createElement("div", { className: "tt-setup-card" },
        React.createElement("h3", null, "设置任务计划"),
        React.createElement("div", { className: "tt-setup-field" },
          React.createElement("label", null, "任务名称"),
          React.createElement("input", { value: taskName, onChange: function (e) { setTaskName(e.target.value); }, placeholder: "本次任务做什么？" })
        ),
        React.createElement("div", { className: "tt-setup-field" },
          React.createElement("label", null, "计划用时（分钟）"),
          React.createElement("input", { type: "number", min: 1, value: plan, onChange: function (e) { setPlan(e.target.value); } })
        ),
        React.createElement("div", { className: "tt-setup-field" },
          React.createElement("label", null, "提醒间隔（分钟）"),
          React.createElement("input", { type: "number", min: 1, value: interval, onChange: function (e) { setInterval(e.target.value); } })
        ),
        React.createElement("div", { className: "tt-setup-actions" },
          React.createElement("button", { className: "tt-setup-start", onClick: function () { var p = parseInt(plan, 10); var iv = parseInt(interval, 10); rpc("set-session-config", { sessionId: setup.sessionId, taskName: taskName.trim(), plannedMinutes: isFinite(p) && p > 0 ? p : null, reminderIntervalMinutes: isFinite(iv) && iv > 0 ? iv : 10 }).then(function () { setSetup(null); }).catch(function () {}); } }, "开始"),
          React.createElement("button", { className: "tt-setup-skip", onClick: function () { rpc("dismiss-session-setup", { sessionId: setup.sessionId }).then(function () { setSetup(null); }).catch(function () {}); } }, "跳过")
        ),
        React.createElement("div", { className: "tt-setup-note" }, "计时仅在模型运行时累加，暂停不计时。也可跳过，稍后在设置中修改。")
      )
    );
  }

  // ---------- Settings section ----------
  function SettingsSection() {
    var state = React.useState({ reminderIntervalMinutes: 10, externalAlert: true });
    var cfg = state[0];
    var setCfg = state[1];
    React.useEffect(function () {
      var alive = true;
      rpc("get-config", {}).then(function (d) { if (alive) setCfg(d); }).catch(function () {});
      return function () { alive = false; };
    }, []);
    return React.createElement("div", { className: "tt-settings" },
      React.createElement("div", { className: "tt-row" },
        React.createElement("label", null, "默认提醒间隔（分钟）"),
        React.createElement("input", { type: "number", min: 1, value: cfg.reminderIntervalMinutes, onChange: function (e) { var v = parseInt(e.target.value, 10); var next = Object.assign({}, cfg, { reminderIntervalMinutes: isFinite(v) && v > 0 ? v : cfg.reminderIntervalMinutes }); setCfg(next); rpc("set-config", { config: next }).catch(function () {}); } })
      ),
      React.createElement("div", { className: "tt-row" },
        React.createElement("label", null, "外部通知（提示音 + 系统弹窗）"),
        React.createElement("input", { type: "checkbox", checked: !!cfg.externalAlert, onChange: function (e) { var next = Object.assign({}, cfg, { externalAlert: e.target.checked }); setCfg(next); rpc("set-config", { config: next }).catch(function () {}); } })
      ),
      React.createElement("div", { className: "tt-hint" },
        "计时为连续累计：只有模型运行时才计时，暂停（等待你的输入）不计时，恢复后接着累计。创建新会话时可填写任务名并设置计划与提醒间隔（也可直接跳过）；提醒卡片右下角堆叠显示，普通提醒约 4 秒、需决策提醒约 9 秒后自动消散（对齐 DSH 内置 Toast 设计），也可点 × 手动关闭；DSH 需要你决策时弹出红色「需要你决策」提醒；任务结束自动统计累计实际用时与计划用时的差距，并写入本地任务记录文件。左下角「🗂 任务面板」可查看全部任务记录（进行中 / 已完成分组），点击任意任务即可跳转到该任务对应的会话对话。"
      )
    );
  }

  // ---------- entry ----------
  var inject = ["sessions", "slots"];
  function apply(ctx) {
    sessionsSvc = ctx.sessions || null;
    var slots = ctx.slots || null;
    if (!slots) return;
    injectStyle();

    slots.inject("shell.overlay", function () {
      return [
        slots.register({ name: "shell.overlay", id: "task-time-setup", order: 50, label: "任务设置" }, SetupManager),
        slots.register({ name: "shell.overlay", id: "task-time-reminder", order: 60, label: "任务提醒" }, ReminderStack),
        slots.register({ name: "shell.overlay", id: "task-time-board", order: 70, label: "任务面板" }, TaskBoard),
      ];
    });

    slots.inject("conversation.composer.dock", function () {
      return slots.register({ name: "conversation.composer.dock", id: "task-time-status", order: 200, label: "任务计时" }, DockEntry);
    });

    slots.inject("settings.section", function () {
      return slots.register({ name: "settings.section", id: "task-time", order: 60, label: () => "任务用时" }, SettingsSection);
    });

    var maxId = 0;
    var poll = setInterval(function () {
      rpc("get-reminders", { since: maxId }).then(function (d) {
        if (d && Array.isArray(d.reminders)) {
          d.reminders.forEach(function (r) {
            if (r.id > maxId) maxId = r.id;
            pushReminder(r);
          });
        }
      }).catch(function () {});
    }, 2000);

    ctx.effect(function () {
      return function () { clearInterval(poll); };
    }, "dsh-task-time:client");
  }

  window.__ModuleLoader__.load({
    id: "dsh-task-time",
    factory: function (require) {
      var module = { exports: {} };
      var exports = module.exports;
      React = require("react");
      exports.name = "dsh-task-time";
      exports.inject = inject;
      exports.apply = apply;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      return module.exports;
    },
  });
})();