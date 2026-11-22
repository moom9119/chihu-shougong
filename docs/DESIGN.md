# 赤狐收工 · 设计说明

> 一个"让你少用手机"的自我约束工具：到点进入限制，界面变灰、小狐狸开始收集羽毛和花朵，
> 想中途退出就得先过一关数字矩阵——而且一旦切屏，小狐狸就会哭给你看。

本文是**实现说明书**：模块怎么分、状态怎么流、数据怎么存、权限边界在哪、边界情况怎么处理。
所有内容都与 `src/` 下的代码一一对应，不是设想。

---

## 0. 交付形态与能力边界（先说清楚）

**这一版是可在浏览器里直接跑通的完整交互原型**（零依赖、零构建，ES Modules + Canvas/SVG）。

| 需求 | 网页里的实现 | 真实设备上需要什么 |
|---|---|---|
| 限制期间灰度 | 应用容器的 CSS `filter: grayscale()` | Android：`Settings.Secure` 的 daltonizer（需 `WRITE_SECURE_SETTINGS`，只能 adb 授权） |
| 拦截其他 App | **做不到**，只能锁住本应用界面 | Android：悬浮窗 + 无障碍服务（`SYSTEM_ALERT_WINDOW` + `AccessibilityService`） |
| 检测"离开软件/切屏" | `visibilitychange` / `blur` / `pagehide` + 宽限计时 | Android：`ACTION_USER_PRESENT`、`UsageStatsManager`、前台服务 |
| 后台可靠计时 | 不可靠（后台标签页会被节流），靠心跳补判 | Android：`AlarmManager.setExactAndAllowWhileIdle` + 前台服务 |

所以本项目的定位是：**逻辑与交互是真的，系统权限是模拟的**。
`src/platform/web.js` 是一个可替换的适配层，换成 Android/Electron 只需重写这一层，`core/` 一行都不用动。

---

## 1. 交互总览

三条主线互相独立，任何一条关掉都不影响另外两条：

```
① 时间主线  时间表 → 提前预警(填任务) → 锁定 → [休息] → 结算
② 摩擦主线  锁定中"解锁/切回" → 数字矩阵 → 通关 → 冷却
③ 陪伴主线  锁定开始 → 小狐狸收集 → 离开则哭 / 坚持则笑 + 收藏一朵花
```

用户一天会看到的完整流程：

1. 首页显示「现在自由 · 距夜间休息 01:12:45」。
2. 开始前 10 分钟弹出任务清单：可从模板选、可自己写、可跳过。
3. 到点进入全屏锁定：界面变灰、倒计时、小狐狸出现并开始收集。
4. 想用手机 → 点「我用手机了」，或切回来时自动弹数字矩阵；按升序点完才关得掉。
5. 勾满任务 → 进度 100% → 发 10 分钟休息：灰度解除、矩阵不弹、狐狸休息。
6. 休息结束回到锁定；坚持到结束 → 结算页：小狐狸开心，收藏册 +1 朵花。
7. 中途切屏超过 3 秒 → 小狐狸哭，本次失败，但锁定继续到结束。

---

## 2. 模块划分

```
src/
├─ core/                    ★ 纯逻辑，零 DOM、零存储、零窗口 API，可整体移植
│  ├─ clock.js              时间源（可注入假时钟 / 加速播放）
│  ├─ settings.js           设置结构、默认值、校验与规范化
│  ├─ schedule.js           时段解析：每日重复 / 星期 / 跨午夜 / 重叠合并
│  ├─ engine.js             核心状态机：reduce(state,event) → {state,effects}
│  ├─ tasks.js              任务增删改、进度、达标判定
│  ├─ matrix.js             矩阵生成、升序校验、错误/超时
│  ├─ fox.js                狐狸收集、暂停、失败、结算判定
│  ├─ collection.js         花朵图鉴、稀有度抽取、连续天数
│  ├─ stats.js              history → 统计视图数据
│  └─ persistence.js        localStorage 读写、版本迁移、损坏恢复、配额降级
├─ platform/
│  ├─ index.js              平台接口契约（JSDoc）
│  ├─ web.js                浏览器实现：灰度、在场检测、通知、WakeLock、音效
│  └─ bgm.js                背景音乐：三档音量、淡入淡出、自动播放解锁、选择落盘
└─ ui/
   ├─ app.js                外壳、路由、事件委托、实时数值刷新
   ├─ dom.js                模板工具 + 花朵/狐狸图形
   ├─ fox-scene.js          Canvas 羽毛花瓣粒子
   ├─ components/           toast.js、matrix-board.js
   └─ views/                home / settings / prewarn / session / result / collection / stats / task-list / window-editor
```

**依赖方向是单向的**：

```
ui ──► core        （ui 只调用纯函数、读 state）
main.js ──► core + platform + ui   （唯一知道全部三层的装配层）
core ✗─► 任何东西   （core 内部只互相引用）
```

这样做的收益：
- `core` 可以 `node --test` 直接跑（本机有 93 个单测）；
- 换平台只改 `platform/`；
- 换界面只改 `ui/views/`；
- 状态机可以原样移植到 Android 的 Kotlin（或继续用 JS + WebView/QuickJS）。

### 2.1 渲染策略（为什么 250ms 一次的 tick 不会让页面"跳"）

`render()` 被每次 dispatch 调用（250ms 一次），所以它**绝对不能整块重画**。做法是：

1. **分片渲染**：顶栏 / 页面 / 底栏 / 叠层四个宿主各存一份上一次的 HTML 字符串，
   只有自己那段变了才替换 `innerHTML`；没变就一个节点都不动。
2. **时钟值不进 HTML**：所有会随时间变化的数字（倒计时、进度、羽毛数、气泡文字）
   在视图里留空的 `[data-live]` 占位，由 `paintLive()` 每帧只改 `textContent` / `style.width`。
3. **入场动画只在换阶段时播**：`.layer` 本身没有动画，`.enter` 由 JS 在
   `phase:sessionId` 变化时添加；同一个叠层内部重绘（勾任务）不重播动画、也不跳回顶部。
4. **Canvas 不重挂**：`scene.mount()` 会判断节点身份，同一个 canvas 直接复用，
   粒子不会被重置。

反例（曾经踩过的坑）：把"现在"指针的位置算进 HTML 字符串，于是每 250ms 字符串都不同，
整块 `innerHTML` 被替换，锁定层的入场动画跟着反复重播 —— 视觉上就是页面一直在跳。

`tools/jank-check.mjs` 就是用来守住这条的：它统计 3 秒内两个宿主的**整块替换次数**，
要求必须是 0，并检查 `.layer` / `.fox-figure` 元素身份没有被重建。

---

## 3. 核心状态流转

### 3.1 顶层状态机

```
                 ┌──────────────────────── 总开关关闭 / 时段删除 / 提前结束 ───────────────┐
                 ▼                                                                      │
   ┌────────┐  到预警点   ┌─────────┐  到开始时间  ┌────────┐  任务达标  ┌──────┐  到结束  │
   │  idle  │ ─────────► │ prewarn │ ──────────► │ locked │ ────────► │ rest │ ────────┤
   │ 自由   │ ◄───────── │ 预警    │             │ 锁定   │ ◄──────── │ 休息 │         │
   └────────┘  跳过填写   └─────────┘             └────────┘  休息到点  └──────┘         │
        ▲                                                                                │
        │                                    ┌────────┐   点击「收下」                    │
        └────────────────────────────────────│ result │ ◄──────────────────────────────┘
                                             │ 结算   │
                                             └────────┘
```

进入各阶段时发生的事：

| 进入 | 副作用 |
|---|---|
| `prewarn` | 写入 runtime 快照、发系统通知「还有 N 分钟」 |
| `locked` | 打开灰度、启动在场检测、申请 WakeLock、狐狸开始收集、播开始音、通知 |
| `rest` | 关闭灰度、矩阵停弹、狐狸转 `paused`、通知「设备恢复可用」 |
| 回到 `locked` | 重新打开灰度、狐狸恢复并给 1.5s 宽限、WakeLock 续上 |
| `result` | 关闭灰度与在场检测、释放 WakeLock、结算音、写 history、成功则抽花 |

### 3.2 狐狸子状态

```
collecting ──(到结束且没离开过)──► success（开心 + 收藏）
     │
     ├──(hidden/blur/pagehide 超过 graceLeaveMs)──► failed（哭泣，本次不发花）
     │
     └──(进入 rest)──► paused ──(rest 结束)──► collecting
```

- 收集是**时间驱动、自动的**：每 20 秒 1 根羽毛（上限 150），每 5 分钟 1 朵花（上限 8）。
  故意不做成"必须盯着屏幕点"，否则等于用另一种方式把人绑在屏幕上。
- 刚进入锁定、以及从休息回到锁定时有 `resumeGraceUntil`（1.2–1.5 秒）的宽限，
  避免"页面还没聚焦就被判失败"。
- 休息期间离开**不算失败**——休息本来就是允许用设备的时间。

### 3.3 矩阵触发周期

```
locked ──触发（切回来 / 点按钮）──► matrix-open
                                      │
                         通关 ────────┴──── 超时 / 点错达上限
                          │                        │
                  关闭 + 冷却 cooldownMinutes    重开一局（弹窗不关）
```

- 弹窗**没有关闭按钮**，ESC / 点遮罩都无效——这是它能起摩擦作用的前提。
- 冷却默认 5 分钟，避免刚通关就被反复弹。
- 点错不重置进度，只累计错误数；错误达到 `maxErrors` 才重开。

### 3.4 事件表（`reduce` 的输入）

| 事件 | 触发来源 | 结果 |
|---|---|---|
| `TICK` | 250ms 定时器 | 驱动全部时间相关转移 |
| `SETTINGS` | 设置面板 | 生效/中止当前会话（关闭总开关 → `aborted`） |
| `PREWARN_DISMISS` | 预警页「跳过」 | 回 idle，记住 `suppressedStartAt` 不再反复弹 |
| `TASK_ADD/TOGGLE/REMOVE/CLEAR/IMPORT` | 任务面板 | 改任务或草稿 |
| `FOX_LEAVE` / `FOX_RETURN` | 平台在场检测 | 判失败 / 无操作 |
| `MATRIX_TRIGGER` / `MATRIX_SOLVED` | 会话页 / 矩阵组件 | 开弹窗 / 关弹窗 + 冷却 |
| `REST_SKIP` | 会话页 | 提前结束休息，回锁定 |
| `EMERGENCY_EXIT` | 长按 `holdSeconds` 秒 | 结算为 `aborted`；`RESULT_ACK` 时把这轮记为"已跳过"，到本轮结束前不再自动锁定 |
| `PREVIEW_START` | `?preview=` | 演练会话，不写统计 |
| `RESULT_FINALIZED` | 装配层抽完花后 | 把奖励回填到结算页 |
| `RESULT_ACK` | 「收下」 | 回 idle；若是长按跳过的，记下 `skippedStartAt`，本轮不再锁 |
| `RESTORE` | 页面启动 | 从快照恢复现场（见 §7） |

### 3.5 副作用（`effects`，由 main.js 执行）

`grayscale` / `sound` / `notify` / `matrix-open` / `matrix-close` / `fox-failed` / `finalize` / `persist`。

状态机只"描述"要发生什么，不亲自做——这样它在 Node 里可以干净地跑测试。

---

## 4. 用户设置项（完整清单）

| 路径 | 类型 / 范围 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | bool | true | **① 总开关**。关掉后所有时段失效 |
| `windows[]` | 1–12 段 | 1 段 | **② 每日重复的限制时段** |
| `windows[].start/end` | `HH:MM` | 22:30 / 07:00 | start > end 即跨午夜；start = end 视为 24h |
| `windows[].days[]` | 0–6（0=周日） | 全选 | 指"**开始**那一天"的星期 |
| `windows[].enabled` | bool | true | **单独开关这一段** |
| `windows[].label` | ≤24 字 | 夜间休息 | 结算与通知里显示 |
| `prewarnMinutes` | 0–60 | 10 | 提前多久弹任务清单；0 = 不预警直接锁 |
| `features.tasks.enabled` | bool | true | **③-1 任务清单功能** |
| `features.tasks.restEnabled` | bool | true | **③-2 达标奖励休息**（可单独关） |
| `features.tasks.restMinutes` | 1–180 | 10 | 休息时长，自动截断到限制结束 |
| `features.tasks.restThresholdPercent` | 50/75/100 | 100 | 达到多少进度可休息 |
| `features.tasks.templates[]` | ≤12 条 | 4 条 | 预警页的模板 chips |
| `features.matrix.enabled` | bool | true | **④ 数字矩阵游戏** |
| `features.matrix.gridSize` | 3–6 | 4 | 格子数 = size² |
| `features.matrix.maxNumber` | ≥ size²，≤144 | 16 | 从 1..max 里抽 size² 个不重复数字 |
| `features.matrix.timeLimitSec` | 0–300 | 30 | 单局限时，0 = 不限 |
| `features.matrix.maxErrors` | 1–10 | 3 | 点错几次重开 |
| `features.matrix.cooldownMinutes` | 0–120 | 5 | 通关后多久不再弹 |
| `features.grayscale.enabled` | bool | true | **⑤ 限制期间自动灰度** |
| `features.grayscale.intensityPercent` | 0–100 | 100 | 灰度强度 |
| `features.grayscale.dimPercent` | 0–60 | 10 | 同时压暗 |
| `fox.graceLeaveMs` | 0–60000 | 3000 | **⑥ 狐狸**：切屏多久算真的离开；0 = 立刻判失败 |
| `emergency.holdSeconds` | 1–10 | 3 | 提前结束需长按多久 |
| `ui.theme` | auto/dark/light | auto | |
| `ui.reduceMotion` | bool | false | 关粒子与弹跳动画 |
| `ui.sound` | bool | true | 音效 |

**校验策略**（`validateSettings`）：任何来源（表单/localStorage/URL）的设置都必须过一遍；
非法值不是抛错，而是**夹到合法区间 + 返回 issues 列表**，UI 用 toast 提示。
例如 `maxNumber < gridSize²` 会被自动抬到 `gridSize²` 并提示。

---

## 5. 持久化数据

| localStorage key | 内容 | 写入时机 |
|---|---|---|
| `foxlock.settings` | 设置 + `schemaVersion` | 设置变更（立即） |
| `foxlock.settings.corrupt` | 损坏设置的原文备份 | 解析失败时 |
| `foxlock.runtime` | 当前会话快照 + `savedAt` | 状态变化 + 每 2 秒心跳 + 页面隐藏 |
| `foxlock.collection` | `{flowers, feathers, successes, failures, streakDays, bestStreak, lastSuccessDate}` | 结算成功/失败时 |
| `foxlock.history` | 近 90 天记录（最多 240 条） | 结算时 |
| `foxlock.meta` | `{installAt, version, lastHeartbeatAt}` | 心跳 |
| `foxlock.bgm` | 背景音乐档位：`off` / `low` / `mid` / `high` | 点击音量按钮或改设置时 |

**迁移**：`migrateSettings` 按 `schemaVersion` 逐版本升级（v0 的 `{from,to}` 会变成 `{start,end}`）。
**损坏**：JSON 解析失败 → 原文挪到 `*.corrupt` → 回默认值 → 顶部提示，不白屏。
**配额**：`QuotaExceededError` → 降级为内存存储并提示"这次改动不会被保存"。
**单实例**：`runtime.savedAt` + 心跳用于判断"页面是否还活着"，多标签页共享同一份 localStorage 时以最新心跳为准。

---

## 6. 权限与系统限制

### 6.1 浏览器这一侧的诚实说明

| 能力 | 状态 |
|---|---|
| 页面级灰度 | ✅ `filter: grayscale()`，覆盖整个应用（含锁定层） |
| 阻止切走 / 拦截其他 App | ❌ 浏览器无此权限 |
| 后台精确计时 | ⚠️ 后台标签页会被节流到 1 分钟级，用 `savedAt` 心跳补偿判断 |
| 通知 | ⚠️ 需用户授权；页面隐藏时部分浏览器禁止构造 Notification |
| 屏幕常亮 | ⚠️ Wake Lock，需 HTTPS 或 localhost |
| 音效 | ⚠️ 需首次用户交互后解锁 AudioContext（已实现，失败则静默跳过） |
| 背景音乐 | ⚠️ 同样受自动播放策略约束：首次点击/按键后才 `play()`。播放条件 = `phase === 'idle'`（四个 tab 页面）且页面可见；进限制场景淡出暂停，回来从断点续播。音量三档 20%/30%/50%，只在小音量区间，不盖过提示音与响铃 |

### 6.2 Android 落地映射（不在本次编译范围）

| 需求 | 实现 | 权限 |
|---|---|---|
| 限制期间覆盖其他 App | 全屏 `Activity` + `TYPE_APPLICATION_OVERLAY` 悬浮层 | `SYSTEM_ALERT_WINDOW`（用户手动开启） |
| 判断"打开了设备" | `ACTION_USER_PRESENT` 广播 + `UsageStatsManager.queryEvents` | `PACKAGE_USAGE_STATS`（用户手动授权） |
| 真·系统灰度 | `Settings.Secure.putInt("accessibility_display_daltonizer_enabled", 1)` + `..._mode` | `WRITE_SECURE_SETTINGS`（仅 adb 可授） |
| 后台准时 | `AlarmManager.setExactAndAllowWhileIdle` + 前台服务 + 电池优化白名单 | `SCHEDULE_EXACT_ALARM`、`FOREGROUND_SERVICE(_SPECIAL_USE)` |
| 通知 | `NotificationCompat` + 渠道 | Android 13+ `POST_NOTIFICATIONS` |
| **读取微信/QQ/钉钉消息** | `NotificationListenerService.onNotificationPosted(sbn)`：按 `packageName` + 通知标题匹配名单，然后 POST 到本机桥 | `BIND_NOTIFICATION_LISTENER_SERVICE`（用户在「通知使用权」里手动授权，无法运行时申请） |
| 防误关 | DeviceAdmin（可选） | 设备管理器 |
| 拦截卸载 | 基本做不到（可要求设备管理员） | — |

### 6.3 iOS

第三方 App 无法做系统级拦截与灰度（`FamilyControls` / `DeviceActivity` 需要 Apple 特批 entitlement）。
**结论：本项目不适合 iOS 真机落地。**

---

## 7. 边界情况处理

| # | 场景 | 处理方式 | 落地位置 |
|---|---|---|---|
| 1 | 跨午夜时段 23:00→07:00 | `end < start` 时结束时间落到次日；`days` 按开始日算 | `schedule.js` |
| 2 | 多个时段重叠 | 合并成一个 session，不重复结算 | `mergeIntervals` |
| 3 | 一天多个不重叠时段 | 各自独立 session | `sessionsInRange` |
| 4 | 总开关关闭 / 时段被删 | 正在进行的会话立即 `aborted`，狐狸不哭也不发花 | `engine.js` `SETTINGS` |
| 5 | 刷新 / 休眠 / 崩溃后重开 | `runtime.savedAt` 与当前时间差 > 宽限 → 判"离开过"，锁定继续 | `restore()` |
| 6 | 重开时已过结束时间 | 直接结算：离开过 → `left`；休息中关闭 → `success` | `restore()` |
| 7 | 休息跨过限制结束 | `restUntil = min(now + restMinutes, endAt)` | `enterRest` |
| 8 | 任务为空 / 一项没勾 | 不发放休息，不报错 | `qualifiesForRest` |
| 9 | 达标后取消勾选 | 进度回退，但已发放的休息不回收（`restGrantedAt` 一次性） | `tick` 中的 `grantedAt == null` 判断 |
| 10 | `restEnabled=false` | 进度照常显示，只是不发休息 | 同上 |
| 11 | 矩阵参数非法 | 保存时纠正（`maxNumber ≥ size²`），运行时二次兜底 | `settings.js` / `matrix.js` |
| 12 | 矩阵进行中会话结束 | 结算副作用直接 `matrix-close` | `endSession` |
| 13 | 冷却期内再切回 | 不弹（引擎判断 `cooldownUntil`） | `MATRIX_TRIGGER` |
| 14 | 点错 / 超时 | 不影响狐狸，只重开一局 | `matrix-board.js` |
| 15 | 存储不可用 / 被清空 | 内存模式 + 明确提示；被清空按"首次运行"处理 | `persistence.js` |
| 16 | 系统时间回拨 | `TICK` 检测 `now < state.now` 时只更新 now，不重放阶段 | `tick()` 开头 |
| 17 | 音频被浏览器拦截 | 首次交互解锁；仍失败则静默跳过 | `platform/web.js` |
| 18 | 无键盘/无障碍 | 矩阵纯键盘可玩（Tab + Enter）；`aria-*`、`prefers-reduced-motion` 支持 | 各视图 |
| 19 | 预警页被跳过 | 记住 `suppressedStartAt`，到点仍然锁，不再反复弹 | `PREWARN_DISMISS` |
| 20 | 演练/预览模式 | `preview=true` 不写 history、不写收藏 | `PREVIEW_START` |
| 21 | 长按提前结束 | 记为"跳过本轮"：`skippedStartAt` 落盘，本轮结束前不再自动锁，也不会刷新后又被锁回去；下一段照常 | `engine.js` `skippedStartAt` |
| 22 | 深夜想测试 | `?test=1` 测试模式：完全不自动进入限制（不写盘）；`?off=1`/`?on=1` 写盘开关总闸 | `main.js` |
| 23 | 想恢复正常夜间休息 | `?night=1`：用 `ensureNightWindow()` 补齐/启用 `22:30–07:00`，再 `SKIP_CURRENT` 跳过当前这一段（`&lock=1` 则不跳过）；设置页也有「＋ 夜间休息」按钮 | `settings.js` / `main.js` |
| 24 | 重要联系人发消息 | `INCOMING_MESSAGE`：名单过滤 → 冷却 → 响铃；限制期间自动暂停，`pause.active` 冻结结束时间与休息到期；恢复时把暂停时长补进 `effectiveEndAt` | `engine.js` `pause` |
| 25 | 消息暂停期间切屏 | 不算狐狸失败、不弹矩阵（与休息同级处理） | `engine.js` `FOX_LEAVE` |
| 26 | 页面打开时桥里有历史消息 | 启动用 `?init=1` 只对齐游标，不重放旧消息 | `main.js` / `serve.mjs` |
| 27 | 没有桥服务（file://） | 直接跳过轮询，不产生 404 噪音 | `main.js` `bridgeAvailable` |

---

## 8. 可扩展点

1. **新增一个功能模块**（如"应用白名单""番茄钟"）：
   加一个 `core/<feature>.js`（纯函数）+ 在设置里加一段 schema + 在 `engine` 里挂 `TICK` 分支 + 一个 `views/` 面板。
   不需要改其它模块，因为状态机是 `switch(event.type)` + 纯函数。
2. **换平台**：实现 `platform/index.js` 里的接口即可（`setGrayscale` / `startPresence` / `notify` / `wakeLock` / `sound`）。
3. **加花朵**：往 `collection.js` 的 `FLOWERS` 里加一条（id / name / rarity / weight / color），图鉴、抽取、收藏自动生效。
4. **加统计维度**：`history` 里已经是结构化记录，`stats.js` 加聚合函数即可。
5. **云端同步**：把 `persistence.js` 的 storage 换成一个异步实现（接口已经是 `get/set/remove`）。

---

## 9. 测试与验收

### 9.1 单元测试（Node，117 项）

```powershell
node --test
```

覆盖：时段解析（跨午夜/星期/重叠/下一段）、设置校验与迁移、存储损坏与配额降级、
引擎全部状态转移（31 项）、任务进度与达标、矩阵生成与点击校验、狐狸成败、收藏与统计。

### 9.2 浏览器验收（CDP，34 项）

```powershell
# 先起服务
node tools/serve.mjs --no-open
# 另开一个窗口
node tools/ui-check.mjs --shots
```

覆盖：真实浏览器启动无异常、灰度 filter 生效、Canvas 有尺寸、任务进度同步、
锁定期间无法切页、矩阵 16 格与升序通关、点错不关闭、离开→哭泣、提前结束→结算、
任务勾满→休息（灰度解除）→结束休息回到锁定、
完整一轮（按时段自动锁定 → 时钟快进到结束 → 收藏 +1、history 写入、连续天数 +1）、
设置落库与刷新保持、收藏/统计渲染、预警页加任务与折叠、
390/768/1280 三档无横向溢出、锁定页元素不越界且不需要滚动。

### 9.3 手工验收（8 条）

见 README 的「5 分钟验收脚本」。

### 9.4 背景音乐验收（CDP，11 项 × 2 个形态）

```powershell
node tools/bgm-check.mjs                                   # 演示页（file://，内联音频）
node tools/bgm-check.mjs "http://127.0.0.1:7317/?test=1"    # 正式版（http，外链音频）
```

覆盖：音源到位、默认 30%、无交互时不硬放、真实点击后循环播放、播放进度在走、
30%→50%→关→20%→30% 四态切换真的落到 `audio.volume`、设置页分段控件同步并能落盘、
切「锁定」淡出暂停、回首页续播、0 条 JS 异常。

> 为什么必须用 `Input.dispatchMouseEvent` 而不是 JS 里 `el.click()`：只有 CDP 的输入事件
> 才带用户激活（user activation），才允许 `play()` 出声；合成的点击会被浏览器拒成
> `NotAllowedError`。这也正是真实用户第一次点击时的路径。

---

## 10. 已知取舍

- **限制期间点底部 tab 会被拦**（提示"先专注眼前这段"），这是有意的：不给绕过入口。
- **矩阵没有关闭按钮**，只有通关；这是摩擦成本，不是 bug。
- **狐狸收集是自动的**：不做点击收集，避免变相要求盯屏。
- **休息每次限制只发一次**：否则反复勾选/取消就能无限续命。
- **预览模式不计入统计**：方便演示，也方便你自己反复测试。
