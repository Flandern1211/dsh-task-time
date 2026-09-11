// dsh-task-time — Client bundle（持久化 profile 插件）
// 浏览器端 UI：composer.dock 计时状态条 + 设置弹窗、shell.overlay 提醒卡/任务面板、
// settings.section 设置页。通信走 HTTP RPC（/api/dsh-task-time/rpc）。
"use strict";
(() => {
  // ---------- CSS ----------
  var style_default = `
  .tt-stack {
    position: fixed;
    bottom: 76px;
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
  .tt-reminder.tt-clickable { cursor: pointer; }
  .tt-reminder.tt-clickable:hover { filter: brightness(1.12); border-color: #4a5468; }
  .tt-reminder.tt-clickable:hover .tt-reminder-foot { color: #eab308; }
  .tt-reminder-foot {
    margin-top: 6px;
    font-size: 11px;
    color: #6a7080;
    display: flex;
    justify-content: flex-end;
    gap: 4px;
  }
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
    right: 20px;
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
    right: 20px;
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
  .tt-board-item .tt-bi-name-wrap { flex: 1; min-width: 80px; font-weight: 600; color: #e8e8e8; white-space: normal; word-break: keep-all; overflow-wrap: break-word; line-height: 1.35; writing-mode: horizontal-tb; }
  .tt-board-item .tt-bi-meta { color: #9aa0b0; font-size: 12px; }
  .tt-board-item .tt-bi-tag { flex-shrink: 0; padding: 2px 8px; border-radius: 10px; font-size: 11px; }
  .tt-board-item .tt-bi-go { flex-shrink: 0; color: #6a7080; font-size: 12px; }
  .tt-board-item:hover .tt-bi-go { color: #eab308; }
  .tt-board-item .tt-bi-del, .tt-board-item .tt-bi-act {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    border: none;
    cursor: pointer;
    margin-left: 6px;
    transition: transform .15s ease, box-shadow .15s ease, background .15s ease, color .15s ease;
    line-height: 1;
    padding: 0;
  }
  .tt-board-item .tt-bi-act {
    background: linear-gradient(135deg, #34d399, #059669);
    color: #06281e;
    box-shadow: 0 1px 4px rgba(16,185,129,.35);
  }
  .tt-board-item .tt-bi-act:hover {
    transform: scale(1.12);
    box-shadow: 0 2px 10px rgba(16,185,129,.55);
    background: linear-gradient(135deg, #4ade80, #10b981);
  }
  .tt-board-item .tt-bi-act:active { transform: scale(.95); }
  .tt-board-item .tt-bi-del {
    background: rgba(248,113,113,.08);
    color: #fca5a5;
    box-shadow: inset 0 0 0 1px rgba(248,113,113,.22);
  }
  .tt-board-item .tt-bi-del:hover {
    transform: scale(1.12);
    background: rgba(248,113,113,.22);
    color: #fff;
    box-shadow: 0 2px 10px rgba(248,113,113,.45);
  }
  .tt-board-item .tt-bi-del:active { transform: scale(.95); }
  .tt-board-item .tt-bi-done-btn { }
  .tt-board-item .tt-bi-done-btn:hover {
    transform: scale(1.12);
    box-shadow: 0 2px 10px rgba(52,211,153,.55)!important;
    background: rgba(52,211,153,.22)!important;
    color: #fff!important;
  }
  .tt-board-item .tt-bi-done-btn:active { transform: scale(.95); }
  .tt-board-item.tt-bi-gone-item { opacity: .75; background: rgba(248,113,113,.05); }
  .tt-bi-gone { color: #f87171; border: 1px solid rgba(248,113,113,.4); }
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
  .tt-settings .tt-btn {
    padding: 5px 12px;
    border: 1px solid var(--dsw-alias-border-l1, #e2e5ea);
    border-radius: 6px;
    background: #eab308;
    color: #1f2430;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
  }
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

  // 自动清除当前会话的「需要决策」提醒（用户已在会话中，不需要卡片继续提醒）。
  function autoDismissDecisionForCurrentSession() {
    try {
      var snap = sessionsSvc && sessionsSvc.list && sessionsSvc.list.getSnapshot();
      var currentId = snap && snap.current;
      if (currentId) {
        dismissDecisionForSession(currentId);
        updateTitleFlash();
      }
    } catch (e) {}
  }

  // 跳转到指定会话（与任务面板共用同一路径：sessionsSvc.open）。
  // 失败静默：会话可能已被删除，调用方负责后续处理（如照常关闭提醒卡）。
  function jumpToSession(sid) {
    if (!sessionsSvc || !sid) return;
    try { var r = sessionsSvc.open(sid); if (r && typeof r.then === "function") { r.catch(function () {}); } } catch (e) {}
    // 跳转后自动清除该会话的决策提醒——用户已经在对应会话中了
    dismissDecisionForSession(sid);
    updateTitleFlash();
  }

  // ---------- reminder store ops ----------
  // 自动消散对齐 DSH 内置 Toast（HOLD_MS=3s + FADE_MS=1s ≈ 4s）：
  // host 传入 autoMs 为全透明保持时长，client 在此之上加 1s 淡出后再移除。
  // autoMs === 0 表示常驻（「需要你决策」提醒）：不自动消散，只能点 × 关闭。
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

  function dismissDecisionForSession(sessionId) {
    // 清除同一会话的所有旧决策卡（手动移除 → 先取消其淡出定时器）
    store.reminders.forEach(function (x) {
      if (x.needDecision && x.sessionId === sessionId) {
        var oldT = reminderTimers.get(x.id);
        if (oldT) { clearTimeout(oldT); reminderTimers.delete(x.id); }
        fadingIds.delete(x.id);
      }
    });
    store.reminders = store.reminders.filter(function (x) {
      return !(x.needDecision && x.sessionId === sessionId);
    });
  }

  function pushReminder(r) {
    var existing = reminderTimers.get(r.id);
    if (existing) clearTimeout(existing);
    fadingIds.delete(r.id);
    // 同一会话的新决策提醒 → 先移除旧决策卡，保持每会话最多一张红色常驻卡
    if (r.needDecision && r.sessionId) dismissDecisionForSession(r.sessionId);
    store.reminders = [r].concat(store.reminders.filter(function (x) { return x.id !== r.id; }));
    if (store.reminders.length > 8) store.reminders = store.reminders.slice(0, 8);
    // autoMs: undefined/无效值 -> 默认 4s；0 -> 常驻不消散；>0 -> 按时长自动消散
    var holdMs = typeof r.autoMs === "number" && isFinite(r.autoMs) ? r.autoMs : 4000;
    if (holdMs > 0) {
      var timer = setTimeout(function () { fadeOutReminder(r.id); }, holdMs);
      reminderTimers.set(r.id, timer);
    } else {
      reminderTimers.delete(r.id);
    }
    emitChange();
  }

  // ---------- ReminderStack ----------
  function ReminderStack() {
    var snap = React.useSyncExternalStore(subscribe, getSnapshot);
    var items = snap.reminders || [];
    if (items.length === 0) return null;
    return React.createElement("div", { className: "tt-stack" },
      items.map(function (r) {
        var cls = "tt-reminder" + (r.needDecision ? " tt-need-decision" : "") + (r.sessionId ? " tt-clickable" : "") + (fadingIds.has(r.id) ? " tt-fading" : "");
        // Click card: jump to its session, then dismiss (the x button only closes).
        // Local-only notices without sessionId (delete results, errors) just close.
        var onCardClick = function () {
          if (r.sessionId) jumpToSession(r.sessionId);
          dismissReminder(r.id);
        };
        var title = r.needDecision ? "❓ " + (r.taskName || "任务") + "：需要你决策" : "⏰ " + (r.taskName || "任务提醒");
        return React.createElement("div", { key: String(r.id), className: cls, onClick: onCardClick },
          React.createElement("div", { className: "tt-reminder-head" },
            React.createElement("span", { className: "tt-reminder-title", title: title }, title),
            React.createElement("button", { className: "tt-reminder-close", onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); dismissReminder(r.id); }, title: "关闭（不跳转）" }, "\u00d7")
          ),
          React.createElement("div", { className: "tt-reminder-body" }, r.text),
          r.sessionId ? React.createElement("div", { className: "tt-reminder-foot" }, "点击跳转到会话 →") : null
        );
      })
    );
  }

  // ---------- TaskBoard ----------
  // 小巧精致的图标按钮（SVG 内联，不依赖字体图标）
  function StopIcon() {
    return React.createElement("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "currentColor", "aria-hidden": "true" },
      React.createElement("rect", { x: 5, y: 5, width: 14, height: 14, rx: 2.5 })
    );
  }
  function TrashIcon() {
    return React.createElement("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
      React.createElement("path", { d: "M3 6h18" }),
      React.createElement("path", { d: "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" }),
      React.createElement("path", { d: "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" }),
      React.createElement("path", { d: "M10 11v6" }),
      React.createElement("path", { d: "M14 11v6" })
    );
  }
  function XIcon() {
    return React.createElement("svg", { width: 11, height: 11, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", "aria-hidden": "true" },
      React.createElement("path", { d: "M18 6L6 18M6 6l12 12" })
    );
  }
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
    // 面板打开时定期刷新，确保关闭会话后任务面板同步更新
    React.useEffect(function () {
      if (!open) return;
      var timer = setInterval(function () {
        rpc("get-task-board", {}).then(function (d) {
          if (d) setData({ active: d.active || [], finished: d.finished || [], file: d.file || null });
        }).catch(function () {});
      }, 3000);
      return function () { clearInterval(timer); };
    }, [open]);
    function goToSession(sid) {
      jumpToSession(sid);
      setOpen(false);
    }
    function deleteRecord(sessionId, finishedAt, ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      rpc("delete-task-record", { sessionId: sessionId, finishedAt: finishedAt }).then(function (d) {
        if (d && d.ok) {
          // 删除成功：面板已本地移除该行作为即时反馈，不再弹提醒卡（否则会遮挡面板）。
          // 即便 host 同步关闭了对应会话（d.closedSession）也静默处理，不弹卡。
          setData({ active: data.active, finished: (data.finished || []).filter(function (f) { return !(f.sessionId === sessionId && f.finishedAt === finishedAt); }), file: data.file });
        } else {
          pushReminder({ id: -Date.now(), kind: 'error', taskName: '删除失败', text: (d && d.error) || '删除失败', ts: Date.now(), needDecision: false, autoMs: 6000 });
        }
      }).catch(function (e) {
        pushReminder({ id: -Date.now(), kind: 'error', taskName: '删除失败', text: '删除失败：' + String((e && e.message) || e) + '。可能需要重启 DSH Desktop 加载新版本插件。', ts: Date.now(), needDecision: false, autoMs: 8000 });
      });
    }
    function endTask(sessionId, ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      rpc("end-task", { sessionId: sessionId }).then(function (d) {
        if (d && d.ok) {
          setData({ active: (data.active || []).filter(function (a) { return a.sessionId !== sessionId; }), finished: (data.finished || []).concat([d.record]), file: data.file });
          pushReminder({ id: -Date.now(), kind: 'ended', taskName: '任务已结束', text: '已结束任务「' + (d.record && d.record.taskName) + '」并归档到已完成。', ts: Date.now(), needDecision: false, autoMs: 6000 });
        } else {
          pushReminder({ id: -Date.now(), kind: 'error', taskName: '结束失败', text: (d && d.error) || '结束任务失败', ts: Date.now(), needDecision: false, autoMs: 6000 });
        }
      }).catch(function (e) {
        pushReminder({ id: -Date.now(), kind: 'error', taskName: '结束失败', text: '结束任务失败：' + String((e && e.message) || e), ts: Date.now(), needDecision: false, autoMs: 8000 });
      });
    }
    function dropTask(sessionId, ev) {
      // 直接移除残留任务（不归档）：用于"会话已删除"的僵尸任务清理
      if (ev && ev.stopPropagation) ev.stopPropagation();
      rpc("drop-task", { sessionId: sessionId }).then(function (d) {
        if (d && d.ok) {
          setData({ active: (data.active || []).filter(function (a) { return a.sessionId !== sessionId; }), finished: data.finished, file: data.file });
          pushReminder({ id: -Date.now(), kind: 'dropped', taskName: '任务已移除', text: '已移除残留任务「' + (d.taskName || '') + '」。', ts: Date.now(), needDecision: false, autoMs: 6000 });
        } else {
          pushReminder({ id: -Date.now(), kind: 'error', taskName: '移除失败', text: (d && d.error) || '移除失败', ts: Date.now(), needDecision: false, autoMs: 6000 });
        }
      }).catch(function (e) {
        pushReminder({ id: -Date.now(), kind: 'error', taskName: '移除失败', text: '移除失败：' + String((e && e.message) || e), ts: Date.now(), needDecision: false, autoMs: 8000 });
      });
    }
    function clearDecision(sessionId, ev) {
      if (ev && ev.stopPropagation) ev.stopPropagation();
      rpc("clear-decision", { sessionId: sessionId }).then(function (d) {
        if (d && d.ok) {
          setData({ active: (data.active || []).map(function (a) {
            if (a.sessionId === sessionId) return Object.assign({}, a, { waitingDecision: false });
            return a;
          }), finished: data.finished, file: data.file });
          pushReminder({ id: -Date.now(), kind: 'decision-cleared', taskName: '决策已清除', text: '已清除该任务的“需决策”状态。', ts: Date.now(), needDecision: false, autoMs: 6000 });
        }
      }).catch(function () {});
    }
    function clearDecisionIcon() {
      return React.createElement("svg", { width: 12, height: 12, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        React.createElement("path", { d: "M20 6L9 17l-5-5" })
      );
    }
    var activeRows = (data.active || []).map(function (a) {
      var tag = a.waitingDecision
        ? React.createElement("span", { className: "tt-bi-tag tt-bi-wait" }, "❓ 需决策")
        : a.running
          ? React.createElement("span", { className: "tt-bi-tag tt-bi-active" }, "运行中")
          : React.createElement("span", { className: "tt-bi-tag tt-bi-paused" }, "已暂停");
      var goneTag = a.sessionGone
        ? React.createElement("span", { className: "tt-bi-tag tt-bi-gone", title: "该会话已删除，任务仍残留" }, "会话已删除")
        : null;
      var endBtn = React.createElement("button", { className: "tt-bi-act", onClick: function (ev) { endTask(a.sessionId, ev); }, title: "结束任务并归档到已完成" }, React.createElement(StopIcon, null));
      var dropBtn = a.sessionGone
        ? React.createElement("button", { className: "tt-bi-del", onClick: function (ev) { dropTask(a.sessionId, ev); }, title: "直接移除该残留任务" }, React.createElement(XIcon, null))
        : null;
      var decisionBtn = a.waitingDecision
        ? React.createElement("button", { className: "tt-bi-done-btn", style: { background: "rgba(52,211,153,.08)", color: "#4ade80", boxShadow: "inset 0 0 0 1px rgba(52,211,153,.22)", flexShrink: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: "50%", border: "none", cursor: "pointer", marginLeft: 6, transition: "transform .15s ease, box-shadow .15s ease, background .15s ease, color .15s ease", lineHeight: 1, padding: 0 }, onClick: function (ev) { clearDecision(a.sessionId, ev); }, title: "标记为已处理，清除需决策状态" }, React.createElement(clearDecisionIcon, null))
        : null;
      return React.createElement("div", { key: a.sessionId, className: "tt-board-item" + (a.sessionGone ? " tt-bi-gone-item" : ""), onClick: function () { goToSession(a.sessionId); if (a.waitingDecision) { rpc("clear-decision", { sessionId: a.sessionId }).catch(function () {}); } }, title: "点击打开该任务会话" },
        React.createElement("span", { className: "tt-bi-name-wrap", title: a.taskName || "未命名任务" }, a.taskName || "未命名任务"),
        tag,
        goneTag,
        React.createElement("span", { className: "tt-bi-meta" },
          "已用 " + fmtClock(a.elapsedMs) + (a.plannedMs ? " · 计划 " + fmtMin(a.plannedMs) : "") + " · 提醒 " + a.remindersFired + " 次"
        ),
        decisionBtn,
        endBtn,
        dropBtn,
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
        React.createElement("button", { className: "tt-bi-del", onClick: function (ev) { deleteRecord(f.sessionId, f.finishedAt, ev); }, title: "删除该任务记录" }, React.createElement(TrashIcon, null)),
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
      var clearDecisionBtn = waiting
        ? React.createElement("button", {
            onClick: function (ev) { ev.stopPropagation(); rpc("clear-decision", { sessionId: sessionId }).then(function () { setStatus(Object.assign({}, status, { waitingDecision: false })); }).catch(function () {}); },
            title: "已处理完毕，清除需决策状态",
            style: { background: "none", border: "1px solid #4ade80", color: "#4ade80", borderRadius: 10, cursor: "pointer", fontSize: 11, padding: "1px 6px", marginLeft: 6, lineHeight: "1.4" }
          }, "✓ 已处理")
        : null;
      statusEl = React.createElement("div", { className: "tt-strip" },
        React.createElement("span", { className: "tt-name" }, label),
        statusText,
        clearDecisionBtn,
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
        console.log('[dsh-task-time] SetupManager poll: currentId=' + currentId + ' allIds=' + JSON.stringify(Object.keys((snap && snap.byId) || {})));
        if (!currentId) {
          setSetup(null);
          pollTimer = setTimeout(refresh, 2000);
          return;
        }
        rpc("get-pending-setup", { sessionId: currentId }).then(function (d) {
          if (!alive) return;
          console.log('[dsh-task-time] get-pending-setup result:', JSON.stringify(d));
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
    var dismiss = function () { rpc("dismiss-session-setup", { sessionId: setup.sessionId }).then(function () { setSetup(null); }).catch(function () {}); };
    return React.createElement("div", { className: "tt-setup", onClick: dismiss },
      React.createElement("div", { className: "tt-setup-card", onClick: function (ev) { if (ev && ev.stopPropagation) ev.stopPropagation(); } },
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
    var state = React.useState({ reminderIntervalMinutes: 10, externalAlert: true, toastAppId: "" });
    var cfg = state[0];
    var setCfg = state[1];
    var diagState = React.useState("");
    var diag = diagState[0];
    var setDiag = diagState[1];
    React.useEffect(function () {
      var alive = true;
      rpc("get-config", {}).then(function (d) { if (alive) setCfg(Object.assign({ reminderIntervalMinutes: 10, externalAlert: true, toastAppId: "" }, d)); }).catch(function () {});
      rpc("get-external-status", {}).then(function (d) { if (alive && d) setDiag(d.toastDiag || ""); }).catch(function () {});
      return function () { alive = false; };
    }, []);
    function testToast() {
      rpc("test-toast", {}).then(function () {
        pushReminder({ id: -Date.now(), kind: "test", taskName: "测试通知已发送", text: "系统通知已发出（身份：" + (cfg.toastAppId || "ai.deepseek.dsh.desktop") + "）。若未看到横幅，请检查 Windows 通知设置/专注助手。", ts: Date.now(), needDecision: false, autoMs: 8000 });
        setTimeout(function () {
          rpc("get-external-status", {}).then(function (d) { if (d) setDiag(d.toastDiag || ""); }).catch(function () {});
        }, 1500);
      }).catch(function (e) {
        pushReminder({ id: -Date.now(), kind: "error", taskName: "测试通知失败", text: String((e && e.message) || e), ts: Date.now(), needDecision: false, autoMs: 8000 });
      });
    }
    return React.createElement("div", { className: "tt-settings" },
      React.createElement("div", { className: "tt-row" },
        React.createElement("label", null, "默认提醒间隔（分钟）"),
        React.createElement("input", { type: "number", min: 1, value: cfg.reminderIntervalMinutes, onChange: function (e) { var v = parseInt(e.target.value, 10); var next = Object.assign({}, cfg, { reminderIntervalMinutes: isFinite(v) && v > 0 ? v : cfg.reminderIntervalMinutes }); setCfg(next); rpc("set-config", { config: next }).catch(function () {}); } })
      ),
      React.createElement("div", { className: "tt-row" },
        React.createElement("label", null, "外部通知（提示音 + 系统弹窗）"),
        React.createElement("input", { type: "checkbox", checked: !!cfg.externalAlert, onChange: function (e) { var next = Object.assign({}, cfg, { externalAlert: e.target.checked }); setCfg(next); rpc("set-config", { config: next }).catch(function () {}); } })
      ),
      React.createElement("div", { className: "tt-row" },
        React.createElement("label", { title: "Windows 通知使用的应用身份（AUMID）。默认借用 DSH Desktop 的已注册身份；留空即默认。" }, "通知应用身份（AUMID）"),
        React.createElement("input", { type: "text", style: { width: 200 }, placeholder: "ai.deepseek.dsh.desktop", value: cfg.toastAppId || "", onChange: function (e) { var next = Object.assign({}, cfg, { toastAppId: e.target.value }); setCfg(next); }, onBlur: function () { var next = Object.assign({}, cfg, { toastAppId: (cfg.toastAppId || "").trim() || "ai.deepseek.dsh.desktop" }); setCfg(next); rpc("set-config", { config: next }).catch(function () {}); } })
      ),
      React.createElement("div", { className: "tt-row" },
        React.createElement("label", null, "外部通知链路"),
        React.createElement("button", { className: "tt-btn", onClick: testToast }, "发送测试通知")
      ),
      diag ? React.createElement("div", { className: "tt-hint" }, "最近通知诊断：" + diag) : null,
      React.createElement("div", { className: "tt-hint" },
        "计时为连续累计：只有模型运行时才计时，暂停（等待你的输入）不计时，恢复后接着累计。创建新会话时可填写任务名并设置计划与提醒间隔（也可直接跳过）；提醒卡片右下角堆叠显示，普通提醒约 4 秒后自动消散；点击提醒卡片可直接跳转到对应会话（卡片随即消失），也可点 × 手动关闭；DSH 需要你决策时弹出红色「需要你决策」提醒（常驻不自动消散 + 系统桌面通知）；任务结束自动统计累计实际用时与计划用时的差距，并写入本地任务记录文件。左下角「🗂 任务面板」可查看全部任务记录（进行中 / 已完成分组），点击任意任务即可跳转到该任务对应的会话对话。"
      )
    );
  }

  // ---------- entry ----------
  var inject = ["sessions", "slots", "remote"];
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
    // ---------- 页面标题闪烁 + 浏览器通知 ----------
    var originalTitle = document.title;
    var titleFlashTimer = null;
    var hasPendingDecision = false;
    var titleFlashActive = false;
    var notifPermissionGranted = false;
    // 请求浏览器通知权限（仅在用户交互时触发）
    function requestNotifPermission() {
      if (notifPermissionGranted || !('Notification' in window)) return;
      try {
        if (Notification.permission === 'granted') { notifPermissionGranted = true; return; }
        if (Notification.permission === 'default') {
          Notification.requestPermission().then(function (p) {
            if (p === 'granted') notifPermissionGranted = true;
          }).catch(function () {});
        }
      } catch (e) {}
    }
    // 浏览器通知：仅当不在当前 tab 时发送
    function sendBrowserNotif(title, body, sessionId) {
      if (!notifPermissionGranted || !('Notification' in window)) return;
      if (document.visibilityState === 'visible') return; // 用户在页面上时不发浏览器通知
      try {
        var n = new Notification(title, { body: body, tag: sessionId || 'dsh-decision', renotify: true });
        if (sessionId) {
          n.onclick = function () { window.focus(); jumpToSession(sessionId); n.close(); };
        }
        setTimeout(function () { n.close(); }, 10000);
      } catch (e) {}
    }
    function updateTitleFlash() {
      var decisionExists = (store.reminders || []).some(function (r) { return r.needDecision; });
      if (decisionExists === hasPendingDecision) return;
      hasPendingDecision = decisionExists;
      if (decisionExists) {
        // 有决策待处理：开始闪烁
        if (titleFlashActive) return;
        titleFlashActive = true;
        var flip = true;
        if (titleFlashTimer) clearInterval(titleFlashTimer);
        titleFlashTimer = setInterval(function () {
          document.title = flip ? '❓ 需要你决策 - ' + originalTitle : originalTitle;
          flip = !flip;
        }, 1000);
      } else {
        // 无决策待处理：恢复标题
        if (titleFlashTimer) { clearInterval(titleFlashTimer); titleFlashTimer = null; }
        titleFlashActive = false;
        document.title = originalTitle;
      }
    }
    // 页面可见时恢复标题 + 自动清除当前会话的决策提醒
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        document.title = originalTitle;
        // 用户回到页面，若当前正在需要决策的会话中，卡片自动消散
        // 因为用户已经在 GUI 中看到问题或审批请求了
        autoDismissDecisionForCurrentSession();
      }
    });
    // 请求通知权限（页面加载后静默请求）
    requestNotifPermission();

    // ---------- 客户端 approval/request 监听 ----------
    // host 侧 dsh-acp 消费了 avalanche 事件（不调 next），使 dsh-task-time host 侧 handler
    // 永远收不到。但 client 侧 ctx.remote.$on 不受此限制（多 handler 并行触发）。
    // 当审批弹窗显示时，推送红卡 + 浏览器通知 + 系统 toast。
    if (ctx && ctx.remote && typeof ctx.remote.$on === 'function') {
      ctx.remote.$on('approval/request', function (request, _next) {
        try {
          console.log('[dsh-task-time] approval/request received:', request && request.toolName);
          // 从当前会话获取 sessionId
          var sid = null;
          try {
            var snap = sessionsSvc && sessionsSvc.list && sessionsSvc.list.getSnapshot();
            sid = snap && snap.current;
          } catch (e) {}
          // 也尝试从 request.agent 获取
          if (!sid && request && request.agent) {
            sid = (typeof request.agent.id === 'string' && request.agent.id) ||
                  (request.agent.session && request.agent.session.id) || null;
          }
          if (sid) {
            var toolName = (request && request.toolName) || '?';
            pushReminder({
              id: -Date.now(),
              kind: 'decision',
              sessionId: sid,
              taskName: null,
              text: '需要你批准「' + toolName + '」',
              ts: Date.now(),
              needDecision: true,
              autoMs: 0
            });
            updateTitleFlash();
            sendBrowserNotif('❓ 需要你批准「' + toolName + '」', '请前往 DSH 处理', sid);
            rpc('trigger-decision-alert', { sessionId: sid, toolName: toolName }).catch(function () {});
          }
        } catch (e) {
          console.error('[dsh-task-time] approval/request handler error:', e);
        }
      });
    }
    // ---------- 会话日志轮询检测审批请求 ----------
    // 最可靠的方式：每次审批请求都会在 session log 中追加 approval/asked 事件，
    // 不受任何插件拦截（不依赖 host 瀑布流或 DOM）。
    var sessionSeqs = {}; // sessionId -> lastSeenSeq
    function checkSessionForApproval() {
      try {
        var snap = sessionsSvc && sessionsSvc.list && sessionsSvc.list.getSnapshot();
        if (!snap || !snap.current) return;
        var sid = snap.current;
        var sessionData = snap.byId && snap.byId[sid];
        if (!sessionData) return;
        var seq = sessionData.seq || 0;
        var lastSeq = sessionSeqs[sid] || 0;
        if (seq <= lastSeq) return;
        // seq 增加了，从 lastSeq 到 seq 之间检查是否有 approval/asked
        for (var i = lastSeq + 1; i <= seq; i++) {
          try {
            var evt = sessionData.eventAt ? sessionData.eventAt(i) : null;
            if (evt && evt.type === 'approval/asked') {
              var toolName = (evt.data && evt.data.toolName) || '?';
              pushReminder({
                id: -Date.now() - i,
                kind: 'decision',
                sessionId: sid,
                taskName: null,
                text: '需要你批准「' + toolName + '」',
                ts: Date.now(),
                needDecision: true,
                autoMs: 0
              });
              updateTitleFlash();
              sendBrowserNotif('❓ 需要你批准「' + toolName + '」', '请前往 DSH 处理', sid);
              rpc('trigger-decision-alert', { sessionId: sid, toolName: toolName }).catch(function () {});
            }
          } catch (e) {}
        }
        sessionSeqs[sid] = seq;
      } catch (e) {}
    }
    checkSessionForApproval();

    var poll = setInterval(function () {
      rpc("get-reminders", { since: maxId }).then(function (d) {
        if (d && Array.isArray(d.reminders)) {
          d.reminders.forEach(function (r) {
            if (r.id > maxId) maxId = r.id;
            pushReminder(r);
            // 新决策提醒：发送浏览器通知
            if (r.needDecision && r.sessionId) {
              sendBrowserNotif('❓ ' + (r.taskName || '任务') + '：需要你决策', r.text, r.sessionId);
            }
          });
        }
        updateTitleFlash();
      }).catch(function () {});
      // 外部 toast 点击跳转：toast.ps1 在用户点击时直接写入跳转文件，
      // host 的 consumeToastJump() 消费文件返回 sessionId，客户端跳转。
      rpc("get-pending-jump", {}).then(function (d) {
        if (d && d.sessionId) jumpToSession(d.sessionId);
      }).catch(function () {});
      // 会话日志轮询：检测新 approval/asked 事件（最可靠，不受插件拦截）
      checkSessionForApproval();
      // 自动清除当前会话的决策提醒：用户在当前会话中能看到审批请求 UI，卡片不再需要
      autoDismissDecisionForCurrentSession();
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
