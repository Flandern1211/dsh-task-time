# dsh-task-time

DeepSeek Harness 插件：任务用时管理与提醒。

## 功能

- **任务计划设置**：新会话自动弹出设置窗口，填写任务名、计划用时、提醒间隔（也可跳过）
- **连续计时**：仅模型运行时累加计时，暂停（等待用户输入）不计时，恢复后续计
- **定时提醒**：按累计运行时间间隔提醒，含提示音 + 系统桌面通知 + 界面提醒卡（自动消散）
- **超时警告**：超过计划用时自动发出超时提醒
- **决策提醒**：模型需要你决策/选择方案时，红色「需要你决策」提醒，避免任务卡住
- **任务面板**：左下角 🗂 按钮打开，进行中 / 已完成分组显示，点击任意任务跳转到对应会话
- **Composer Dock 状态条**：输入框下方显示当前任务名、运行状态、已用时间、计划时间、提醒次数
- **设置页面**：全局设置页可调整默认提醒间隔和外部通知开关
- **持久化**：任务记录写入 `~/.dsh/dsh-task-time-records.json`，重启后保留，上限 500 条

## 安装

### 方式一：从 npm 安装

```bash
dsh plugin add dsh-task-time
```

### 方式二：从 GitHub 仓库安装

```bash
dsh plugin add https://github.com/你的用户名/dsh-task-time
```

### 方式三：本地安装

```bash
git clone https://github.com/你的用户名/dsh-task-time.git
cd dsh-task-time
dsh plugin add .
```

安装后重启 DeepSeek Harness，插件自动加载。

## 使用

1. **创建新会话** → 自动弹出「设置任务计划」窗口（可填写任务名、计划用时、提醒间隔，或点跳过）
2. **任务进行中** → 输入框下方显示状态条：任务名 + ⏱运行中/⏸已暂停/❓需要你决策 + 已用时间 + 计划时间
3. **定时提醒** → 右下角出现提醒卡，10 秒后自动消散；需决策提醒为红色，30 秒后消散
4. **任务面板** → 点击左下角 🗂 按钮，查看进行中和已完成的任务记录，点击任意任务跳转
5. **任务结束** → 自动统计实际用时 vs 计划用时的差距，写入记录文件

## 命令

模型可通过 `task_plan_set` 工具在运行中调整计划用时。

## 记录文件

- 位置：`~/.dsh/dsh-task-time-records.json`
- 字段：`sessionId / taskName / startedAt / finishedAt / plannedMs / actualMs / diffMs`
- 上限 500 条，超限自动淘汰旧记录

## 配置

在 DSH 设置 → 任务用时 中可调整：

- **默认提醒间隔**（分钟，默认 10）
- **外部通知**（提示音 + 系统弹窗，默认开启）

## 开发者

- Host：`lib/index.js` — 计时、提醒、持久化、webServer RPC、tool 注册、prompt section
- Client：`lib/client.js` — 浏览器 UI（`window.__ModuleLoader__.load` 格式，fetch RPC）
- 安装方式：profile bundle，通过 `cordis.patch.yml` 插入 host composition

## License

MIT