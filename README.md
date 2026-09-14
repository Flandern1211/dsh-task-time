# dsh-task-time

> **DeepSeek Harness 任务用时管理与提醒插件** — 为每个会话设置计划用时，连续计时，定时提醒，自动统计。

[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-4ade80?style=flat-square)](https://github.com/deepseek-ai/deepseek-harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-blue?style=flat-square)](package.json)

---

## 目录

- [功能概览](#功能概览)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用指南](#使用指南)
- [功能详解](#功能详解)
- [命令](#命令)
- [配置](#配置)
- [记录文件](#记录文件)
- [项目结构](#项目结构)
- [开发](#开发)
- [License](#license)

---

## 功能概览

| 功能 | 描述 |
|------|------|
| ✅ **任务计划设置** | 新会话自动弹出设置窗口，填写任务名、计划用时、提醒间隔（只有点「跳过」才会跳过，误触不会） |
| ✅ **连续计时** | 仅模型运行时累加计时，暂停（等待用户输入）不计时，恢复后续计 |
| ✅ **定时提醒** | 按累计运行时间间隔提醒：在 DSH 里走内部通知（提醒卡 + 提示音），不在 DSH 里才发系统通知 |
| ✅ **提醒卡可点击跳转** | 点击界面提醒卡直接跳转到该提醒所属的会话 |
| ✅ **系统通知可点击跳转** | Windows 通知横幅点击后自动跳转到对应会话 |
| ✅ **超时警告** | 超过计划用时自动发出超时提醒 |
| ✅ **决策提醒** | 模型需要决策时，红色「需要你决策」提醒（常驻）+ 系统桌面通知 |
| ✅ **任务面板** | 左下角 🗂 按钮打开，进行中 / 已完成分组，点击跳转会话 |
| ✅ **Composer Dock 状态条** | 输入框下方实时显示任务名、运行状态、用时、计划时间、提醒次数 |
| ✅ **浏览器标题闪烁** | 需要决策时浏览器标签页标题闪烁提醒 |
| ✅ **内部通知 / 外部通知分流** | 人在 DSH 里只发内部通知（提醒卡 + 界面内提示音），人不在 DSH 里才发系统通知，并可配置「外部通知时机」 |
| ✅ **设置页面** | 模块开关 + 该模块最需要的配置：任务用时里配默认计划用时 / 默认提醒间隔，提醒里配外部通知时机 / AUMID / 测试通知 |
| ✅ **持久化** | 任务记录写入 `~/.dsh/dsh-task-time-records.json`，重启后保留 |
| ✅ **页面标题闪烁** | 有决策待处理时标题闪烁 ❓ 需要你决策 |
| ✅ **浏览器通知** | 不在当前标签页时通过浏览器 Notification API 推送提醒 |
| ✅ **DOM 审批弹窗监听** | MutationObserver 兜底检测审批弹窗，确保决策提醒不漏报 |

---

## 安装

### 方式一：从 npm 安装（推荐）

```bash
dsh plugin add dsh-task-time
```

### 方式二：从 GitHub 仓库安装

```bash
dsh plugin add https://github.com/Flandern1211/dsh-task-time
```

### 方式三：本地安装

```bash
git clone https://github.com/Flandern1211/dsh-task-time.git
cd dsh-task-time
dsh plugin add .
```

安装后重启 DeepSeek Harness，插件自动加载。

---

## 快速开始

1. **创建新会话** → 自动弹出「设置任务计划」窗口
2. **填写任务信息**：
   - 任务名称（如"代码审查"、"文档编写"）
   - 计划用时（分钟，预填 设置 → 任务用时 → 默认配置 里的「默认计划用时」，默认 60）
   - 提醒间隔（分钟，预填默认 10）
3. 点击 **开始** 保存；只有点 **跳过** 才会跳过本次设置
   - 点击弹窗外区域**不会**关闭/跳过（只弹出提示），避免误触把设置吞掉
   - 跳过后想补设置：在输入框下方的计时条点 **⚙ 设置计划** 即可重新打开弹窗
4. 任务进行中，输入框下方显示状态条
5. 超时、决策、提醒自动触发，无需手动操作

---

## 使用指南

### 任务面板

点击左下角 🗂 按钮打开任务面板，查看全部任务：

- **进行中** — 当前运行的任务，显示状态（运行中 / 已暂停 / 需决策）、已用时间、计划时间
- **已完成** — 已结束的任务，显示实际用时、与计划的差异
- 点击任意任务 → 跳转到对应会话
- 进行中任务可「结束」归档，已完成记录可「删除」

### 计时规则

- **只计模型运行时间**：模型在思考、调用工具时累加计时
- **暂停不计时**：等待用户输入、审批时暂停计时
- **恢复后续计**：模型再次运行后续计

### 决策提醒

当以下情况触发时，插件自动发出「需要你决策」提醒：

- **`approval/request`** 事件 — 沙箱升级、权限审批等
- **`ask_user_question`** 调用 — 模型向用户提问
- **工具执行**（`ask_user_question` / `confirm` / `approve`）
- **DOM 审批弹窗**（`[data-approval-key]`）—— MutationObserver 兜底检测

决策提醒特征：
- 🔴 **红色提醒卡**（常驻不自动消散，点 × 关闭）
- 🔴 **Windows 系统通知**（循环报警音）
- 🔴 **浏览器标签页标题闪烁**
- 🔴 **浏览器通知**（不在当前标签页时）

---

## 功能详解

### 提醒卡系统

- **普通提醒卡**：右下角堆叠显示，约 4 秒后自动淡出消散
- **决策提醒卡**：红色常驻，不自动消散，只能点 × 关闭
- **点击跳转**：点击提醒卡 → 跳转到对应会话 → 卡片消失
- **点击 ×**：仅关闭卡片，不跳转

### 通知：内部 / 外部两条通道

通知按「人是不是正在 DSH 里」自动分流，不会在你看得见界面的时候还弹系统通知：

| 人在哪 | 通道 | 表现 |
|--------|------|------|
| **在 DSH 里**（页面可见，默认还要求窗口在前台） | 内部通知 | 右下角提醒卡（决策时红色常驻）+ **界面内提示音**（WebAudio 合成，不依赖外部文件）+ 需要决策时标题闪烁 |
| **不在 DSH 里**（切到别的窗口 / 最小化 / 关掉页面） | 外部通知 | Windows 系统 Toast（含系统提示音）+ 浏览器通知，点击可跳回会话 |

- client 每 2 秒（以及焦点/可见性变化时）向 host 上报一次 `ui-presence`（focused / visible）；host 超过 10 秒收不到上报就按「人不在 DSH」处理，保证页面关掉后仍然收得到系统通知
- 判定结果由 host 统一计算并通过 `ui-presence` 的返回值同步回 client，两边结论一致：**响了内部提示音就不会再发系统通知，反之亦然**
- 「外部通知时机」可配置：`DSH 不在前台时`（默认，切走就发）或 `只有 DSH 页面不可见时`（只要 DSH 还看得见就不发）；设置页「当前状态」实时显示此刻算不算「在 DSH 里」
- 「发送测试通知」按钮**不受时机限制**，任何时候点都会真发一条，方便验证链路

### 外部通知（Windows 系统 Toast）

- 默认借用 DSH Desktop 的 AUMID（`ai.deepseek.dsh.desktop`）发出通知
- 支持自定义 AUMID
- 可一键发送测试通知验证链路
- Windows 11 默认静默丢弃未注册应用身份的通知，插件已做适配
- 只在**人不在 DSH 里**时才发（见上一节的通道表）

### 外部通知声音

| 场景 | 声音 |
|------|------|
| 任务结束 | `Notification.IM` |
| 定时提醒 | `Notification.Reminder` |
| 决策提醒 | `Notification.Looping.Alarm` |
| 超时提醒 | `Notification.Looping.Alarm2` |

### 标记状态颜色

| 状态 | 颜色 |
|------|------|
| 运行中 | 🟡 `#eab308` |
| 已暂停 | 🔵 `#60a5fa` |
| 需要决策 | 🔴 `#f87171` |
| 已完成 | 🟢 `#4ade80` |
| 超时 | 🟠 `#fb923c` |

### 持久化与重启恢复

- 记录文件：`~/.dsh/dsh-task-time-records.json`
- 重启后恢复全部状态：
  - 已完成记录
  - 会话配置（已配置 / 已跳过）
  - 运行中任务（从当前时间续计，停机时间不计入）
  - 会话历史
- 防抖写入（800ms），避免频繁磁盘 I/O
- 退出时同步落盘，确保数据不丢失

### 孤儿任务清理

插件每 3 秒检查一次存活会话，自动清理：

- **运行中但会话已删除** → 静默收尾计入已完成记录
- **从未启动且会话已删除** → 清除残留条目
- 确保任务面板不显示僵尸任务

---

## 命令

### 模型工具：`task_plan_set`

模型可在运行中通过此工具调整当前任务的计划用时。

```json
{
  "plannedMinutes": 30,
  "note": "任务说明（可选）"
}
```

- 修改后自动取消超时标记（`overdueFired = false`）
- 若任务尚未启动，自动设置启动时间
- 返回确认消息含新计划和提醒间隔

> 此工具已注册到模型 system prompt，会在合适的时机自动调用。

---

## 模块开关（按需启用）

插件分为 **任务用时** 与 **提醒** 两大模块，可在设置中自由开关，两者完全独立。

在 DSH 设置 → **任务用时** → **模块开关与默认配置** 中配置：

```
任务用时
☑ 启用任务用时
  ☑ 计时引擎（运行/暂停连续计时）
  ☑ 计划配置（设置弹窗 / 跳过恢复）
  ☑ 定时提醒（间隔提醒 + 超时提醒）
  ☑ 任务面板（进行中/已完成 + 操作）
  ☑ Dock 状态条（输入框下方实时显示）
  ☑ 孤儿清理（会话已删除的残留清理）
  ─ 默认配置（新会话设置弹窗的预填值）
    默认计划用时   [60 分钟 ▾]（15/30/45/60/90/120/180 或「自定义…」）
    默认提醒间隔（分钟） [10]

提醒
☑ 启用提醒
  ☑ 决策检测（三通道 + 客户端独立检测）
  ☑ 内部通知（在 DSH 里：提醒卡 + 提示音）
  ☑ 外部通知（不在 DSH 里：系统 Toast + AUMID）   ← 外部通知只有这一个开关
  ☑ 标题闪烁（需要决策时）
  ☑ Toast 点击跳转（文件兜底 + 轮询消费）
  ─ 外部通知配置
    外部通知时机   [DSH 不在前台时 ▾]（或「只有 DSH 页面不可见时」）
    当前状态       [在 DSH 里 → 只发内部通知 / 不在 DSH → 会发系统通知]
    通知应用身份（AUMID） [ai.deepseek.dsh.desktop]
    外部通知链路   [发送测试通知]
```

> 外部通知**只有一个开关**：提醒模块下的「外部通知」。它的时机、应用身份与测试入口在同一个模块的「外部通知配置」里，不再有第二个会互相覆盖的开关。
> 通知按「人在不在 DSH 里」走两条通道：在 DSH 里只发内部通知（提醒卡 + 界面内提示音），不在 DSH 里才发系统通知 —— 见上方「通知：内部 / 外部两条通道」。

**行为说明**

| 配置 | 结果 |
|------|------|
| 只开 **提醒**、关掉 **任务用时** | 只保留决策提醒（红卡 + 系统通知），不显示设置弹窗、任务面板、Dock 状态条 |
| 关掉主开关 | 该模块下所有子开关被屏蔽；子开关保留各自状态，主开关重新打开后恢复原状 |
| 关掉 **内部通知** | 右下角不再显示任何提醒卡、不再响界面内提示音（系统通知仍可用） |
| 关掉 **外部通知** | 人不在 DSH 时不再发系统 Toast / 浏览器通知（「发送测试通知」按钮仍可用） |
| 关掉 **任务用时** | 不再计时、不产生"任务完成"提醒（没有任务就没有完成事件） |

**配置文件**：`~/.dsh/dsh-task-time-modules.json`

> ⚠️ **改完开关需要重启 DSH Desktop（或刷新页面）才会生效** —— 客户端 bundle 在应用启动时载入，热更新仅在 `pnpm run dev:web` 运行时可用。

---

## 配置

在 DSH 设置 → **任务用时** 中可调整（配置就放在对应模块里）：

| 配置项 | 位置 | 描述 | 默认值 |
|--------|------|------|--------|
| 默认计划用时 | 任务用时 → 默认配置 | 新会话「设置任务计划」弹窗的预填值（预设下拉或自定义） | 60 分钟 |
| 默认提醒间隔 | 任务用时 → 默认配置 | 累计运行多长时间提醒一次（分钟），也是设置弹窗的预填值 | 10 |
| 内部通知 | 提醒 → 模块开关 | 在 DSH 里时的提醒卡 + 界面内提示音 | 开启 |
| 外部通知 | 提醒 → 模块开关 | 不在 DSH 里时的系统通知（**唯一开关**，开/关只看它） | 开启 |
| 外部通知时机 | 提醒 → 外部通知配置 | `DSH 不在前台时`（默认）/ `只有 DSH 页面不可见时` | `unfocused` |
| 当前状态 | 提醒 → 外部通知配置 | 实时显示此刻算不算「在 DSH 里」（只读，5 秒刷新） | — |
| 通知应用身份（AUMID） | 提醒 → 外部通知配置 | 系统通知的应用身份 | `ai.deepseek.dsh.desktop` |
| 外部通知链路 | 提醒 → 外部通知配置 | 「发送测试通知」按钮，手动验证 Toast + 提示音（不受时机限制） | — |

### 配置说明

**AUMID（AppUserModelId）** 是 Windows 通知系统的关键标识：

- 默认借用 DSH Desktop 的已注册身份，横幅可正常弹出
- 留空使用默认值
- 修改后可通过 **发送测试通知** 验证
- 最近一次通知诊断信息会显示在设置页面下方

---

## 记录文件

- **位置**：`~/.dsh/dsh-task-time-records.json`
- **容量**：上限 500 条，超限自动淘汰旧记录

### 记录字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `sessionId` | string | 会话 ID |
| `taskName` | string | 任务名称 |
| `startedAt` | string (ISO) | 启动时间 |
| `finishedAt` | string (ISO) | 完成时间 |
| `plannedMs` | number | 计划用时（毫秒） |
| `actualMs` | number | 实际用时（毫秒） |
| `diffMs` | number | 差距（毫秒，正数 = 超时） |

### 持久化数据结构

```
{
  "records": [ ... ],      // 已完成记录
  "configs": { ... },       // 会话配置（含 configured 标记）
  "dismissed": [ ... ],    // 跳过设置的会话列表
  "tasks": { ... },         // 进行中任务
  "history": { ... },       // 会话历史
  "defaults": { ... }       // 全局默认配置
}
```

---

## 项目结构

```
dsh-task-time/
├── lib/
│   ├── index.js          # Host 端：计时、提醒、持久化、RPC、工具注册、prompt section
│   ├── index.d.ts        # Host 端类型声明
│   ├── client.js         # Client 端：浏览器 UI（React）、提醒卡、任务面板、设置页
│   ├── client.d.ts       # Client 端类型声明
│   └── toast.ps1         # Windows WinRT Toast 通知脚本（PowerShell 5.1+）
├── scripts/
│   ├── verify.mjs        # 自动验证脚本（mock 运行时，5 个场景）
│   └── test-changes.mjs  # 变更合规性检查
├── cordis.patch.yml      # 插件 bundle patch（插入 host composition）
├── package.json          # npm 包配置
├── README.md             # 本文件
├── LICENSE               # MIT License
└── .gitignore
```

### 架构说明

```
┌──────────────────────────────────────────────────┐
│                   DSH Desktop                     │
│  ┌─────────────────────────────────────────────┐  │
│  │              Host 进程 (Electron)             │  │
│  │  ┌─────────────────────────────────────────┐ │  │
│  │  │         dsh-task-time (Host)             │ │  │
│  │  │  • 计时 & 提醒 (3s tick)                 │ │  │
│  │  │  • 持久化 (防抖 800ms)                    │ │  │
│  │  │  • 外部通知 (spawn toast.ps1)            │ │  │
│  │  │  • HTTP RPC 服务 (/api/dsh-task-time/rpc)│ │  │
│  │  │  • tool: task_plan_set                    │ │  │
│  │  │  • prompt section 注册                    │ │  │
│  │  │  • 事件监听 (agent/created/status/disposed│ │  │
│  │  │  • 决策提醒 (三通道)                       │ │  │
│  │  │  • 孤儿任务清理                            │ │  │
│  │  └─────────────────────────────────────────┘ │  │
│  │                     │ HTTP RPC                │  │
│  │                     ▼                         │  │
│  │  ┌─────────────────────────────────────────┐ │  │
│  │  │        Renderer 进程 (Browser)           │ │  │
│  │  │  ┌─────────────────────────────────────┐ │ │  │
│  │  │  │    dsh-task-time (Client)            │ │ │  │
│  │  │  │  • 设置弹窗 (shell.overlay)          │ │ │  │
│  │  │  │  • 提醒卡堆叠 (shell.overlay)        │ │ │  │
│  │  │  │  • 任务面板 (shell.overlay)          │ │ │  │
│  │  │  │  • 状态条 (composer.dock)            │ │ │  │
│  │  │  │  • 设置页 (settings.section)         │ │ │  │
│  │  │  │  • 标题闪烁 / 浏览器通知              │ │ │  │
│  │  │  │  • DOM 审批弹窗兜底                   │ │ │  │
│  │  │  │  • 每 2s 轮询 + 上报 ui-presence      │ │ │  │
│  │  │  └─────────────────────────────────────┘ │ │  │
│  │  └─────────────────────────────────────────┘ │  │
│  └─────────────────────────────────────────────┘  │
│                     │ OS                          │
│                     ▼                             │
│  ┌─────────────────────────────────────────────┐  │
│  │  Windows Toast (toast.ps1 via powershell)    │  │
│  │  • WinRT ToastNotificationManager            │  │
│  │  • 点击 → second-instance → pendingJump → 跳转 │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## 开发

### 技术栈

| 层 | 技术 |
|----|------|
| Host | Node.js (ESM), Electron (可选) |
| Client | React (via ModuleLoader), 原生 JS |
| 通信 | HTTP POST RPC (`/api/dsh-task-time/rpc`) |
| 通知 | Windows WinRT Toast (PowerShell toast.ps1) |
| 持久化 | JSON 文件 (`~/.dsh/dsh-task-time-records.json`) |
| 打包 | cordis patch (`cordis.patch.yml`) |

### 构建

```bash
# 构建（如果使用 TypeScript 源码）
npm run build

# 或直接修改 lib/ 下文件（JS 源码无构建步骤）
```

### 验证

```bash
# 运行完整自动验证（mock 运行时，无需 DSH Desktop）
node scripts/verify.mjs

# 运行变更合规检查
node scripts/test-changes.mjs
```

验证脚本覆盖 5 个场景：
1. **Legacy 迁移** — 旧格式记录文件迁移
2. **状态恢复** — configs/dismissed/tasks/history/defaults 重启恢复
3. **决策提醒** — 三通道（approval/userQuestions/tools-pre-execute）+ 20s 节流
4. **持久化写入** — 配置写入 + 重加载验证
5. **孤儿任务清理** — 已删除会话的残留任务清理

### 部署

插件作为 profile bundle 安装，通过 `cordis.patch.yml` 插入 host composition：

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-task-time
      name: 'dsh-task-time'
```

### 事件钩子

| 事件 | 用途 |
|------|------|
| `agent/created` | 新会话创建时检查是否需要弹出设置窗 |
| `agent/status` | 监听运行/暂停状态切换，累计计时 |
| `agent/disposed` | 会话关闭时自动结束任务并归档 |
| `approval/request` | 需要审批时触发决策提醒 |
| `internal/service` | 监听 userQuestions 服务注册，hook ask 方法 |
| `tools/pre-execute` | 确认类工具执行前兜底触发决策提醒 |

### RPC 接口

所有通信通过 HTTP POST `POST /api/dsh-task-time/rpc`，请求体格式：

```json
{ "method": "methodName", "args": { ... } }
```

| 方法 | 用途 |
|------|------|
| `get-pending-setup` | 查询会话是否待设置 |
| `get-pending-sessions` | 查询所有待设置会话 |
| `get-status` | 获取某会话计时状态 |
| `get-reminders` | 获取增量提醒 |
| `get-pending-jump` | 获取待处理的 toast 点击跳转 |
| `get-config` | 获取全局配置 |
| `set-config` | 设置全局配置 |
| `get-session-config` | 获取会话配置 |
| `set-session-config` | 设置会话配置 |
| `dismiss-session-setup` | 跳过会话设置（仅由「跳过」按钮调用） |
| `reopen-session-setup` | 撤销「已跳过」，重新打开设置弹窗（计时条「⚙ 设置计划」） |
| `get-history` | 获取会话历史 |
| `get-task-board` | 获取任务面板数据 |
| `end-task` | 结束任务 |
| `drop-task` | 移除残留任务 |
| `delete-task-record` | 删除已完成记录 |
| `clear-task-records` | 清空全部已完成记录 |
| `test-toast` | 测试通知 |
| `trigger-decision-alert` | 触发决策提醒 |

### 已知问题 / 边界情况

- **Windows 11 通知静默丢弃**：未注册 AUMID 的通知可调用成功但横幅不显示，默认身份为 DSH Desktop 的已注册身份
- **PowerShell 5.1 编码**：`toast.ps1` 保持纯 ASCII，非 ASCII 注释会导致 ANSI/GBK 解码错误
- **Electron 可选**：toast 点击跳转依赖 Electron `second-instance` 事件，无 Electron 时仅激活窗口不跳转

---

## 更新日志

### v0.2.5

- **改进** 系统提示词同步双通道行为：原来写的是「含系统提示音与桌面通知」，v0.2.4 改成按人在不在 DSH 分流后文案没跟上——现在改为「人在 DSH 里时发界面内提醒卡 + 提示音，不在 DSH 里时发系统桌面通知；需要决策时界面内常驻红卡，不在 DSH 里时额外发桌面通知」，避免 agent 向用户转述错误的通知方式
- **清理** 移除调试期留下的 `console.log`：host 端 6 处（`get-pending-setup` 每次弹窗轮询都打一行、两条 stale waitingDecision 分支、三处 cleared waitingDecision）、client 端 3 处（`SetupManager poll` 每 2 秒打一行并 `JSON.stringify` 全部会话 id、`get-pending-setup` 结果、approval/request 到达）——这些在 DSH 控制台里会持续刷屏，且 `SetupManager poll` 的字符串拼接本身有开销
- **清理** 保留 4 处真正有诊断价值的日志（模块配置加载/保存失败的 `console.warn`、`session/event` 与 `approval/request` 处理异常的 `console.error`）
- 移除仓库里的临时文件：`.npm-cache/`（暂存的 npm 缓存，已加入 `.gitignore`）与 `_dbg_channels.mjs`（调试探针，功能已被 `scripts/verify-channels.mjs` 覆盖）
- 顺带修正 `clearWaitingDecision` 三处调用点残留的缩进

### v0.2.4

- **修复** 设置弹窗误判为「跳过」：遮罩（弹窗外区域）点击不再等于跳过——以前点一下弹窗外区域就会永久跳过本次设置，鼠标滑出窗口后点回窗口、或在输入框里拖拽选字时松手到卡片外，都会命中这条路径
- **新增** 误跳过可恢复：计时条新增「⚙ 设置计划」，对应的 `reopen-session-setup` RPC 会撤销「已跳过」标记并重新弹出设置窗
- **改进** `get-status` 增加 `configured` 字段；设置弹窗点击遮罩时给出提示文案
- **修复** 外部通知有两个开关互相打架：设置页原来的「外部通知（提示音 + 系统弹窗）」勾选框与提醒模块里的「外部通知」开关会各自覆盖对方（开关显示「开」、实际被旧值静默关掉）。现在**只保留模块开关里的那一个**，旧配置项 `defaults.externalAlert` / `session.externalAlert` 已移除
- **新增** 任务用时的可修改默认配置：设置页「任务用时 → 默认配置」可改**默认计划用时**（15/30/45/60/90/120/180 预设或自定义）与默认提醒间隔，新会话设置弹窗按此预填（`defaults.plannedMinutes`，`get-pending-setup` 下发 `defaultPlannedMinutes`）
- **改进** 设置页按模块分组：开关与这个模块最需要的配置放在同一组里（任务用时 → 默认配置；提醒 → 外部通知配置 + **发送测试通知**按钮）
- **新增** 内部通知 / 外部通知双通道：client 每 2 秒上报 `ui-presence`（焦点 + 可见性，超时 10 秒按离开处理），host 用 `shouldSendExternal()` 统一判定——**人在 DSH 里只发内部通知**（提醒卡 + WebAudio 合成提示音），**不在 DSH 里才发系统通知**；判定结果回传 client，两个通道不会同时响
- **新增** 「外部通知时机」配置（`defaults.externalWhen`）：`DSH 不在前台时`（默认）或 `只有 DSH 页面不可见时`；设置页「当前状态」实时显示此刻算不算「在 DSH 里」
- **改进** 通知开关改为对称的一对：`内部通知（在 DSH 里：提醒卡 + 提示音）` / `外部通知（不在 DSH 里：系统 Toast + AUMID）`；浏览器通知也归外部通道（人在 DSH 里不再弹）；「发送测试通知」不受时机限制
- **修复** 插件刚加载就被停用时，停用回调会拿**内置默认值**覆盖磁盘上已存的配置（默认计划用时 / 外部通知时机等）—— 现在只有状态真的从磁盘恢复过（`stateLoaded`）才落盘，且停用落盘改用 `RECORDS_FILE` 而不是另写一份硬编码路径
- **修复** `get-config` / `get-external-status` 现在会 `await ensureLoaded()`，设置页不会先显示内置默认值再跳变

### v0.2.1 (2026-09-10)

- **修复** `end-task` 缺少 history 截断，已完成记录可无限增长
- **修复** 决策节流记录（`decisionAlerts`）只增不删导致内存泄漏 + 新决策被旧节流压制
- **修复** 任务结束时未清理决策节流记录，影响同一会话的新任务
- **修复** 跳过会话设置时丢弃已累积的任务计时，改为归档到已完成记录
- **修复** `set-session-config`/`dismiss-session-setup` 中 `persistRecords()` 无 await，即时落盘保证不可靠
- **修复** 3s tick 定时器可能重叠执行导致竞态，改为递归 `setTimeout`
- **修复** `tools/pre-execute` 正则未锚定，子串匹配可误触发决策提醒

### v0.2.0

- 首个正式发布版本，完整功能集见上方功能概览

---

## License

MIT License — 详见 [LICENSE](LICENSE)

Copyright (c) 2026 dsh-task-time contributors