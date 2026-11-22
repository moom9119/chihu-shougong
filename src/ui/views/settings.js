/**
 * ui/views/settings.js —— 所有开关与参数都在这里，按"一块功能一张卡"组织。
 * 时间表（限制时段）已移到「记录」页，这里只留一个入口提示。
 */
import { MATRIX_LIMITS, INTERRUPT_APPS, appMeta } from '../../core/settings.js';
import { esc, stepper, segmented, toggleSwitch, row } from '../dom.js';

export function settingsView(ctx) {
  const { settings, caps } = ctx;
  const t = settings.features.tasks;
  const m = settings.features.matrix;
  const g = settings.features.grayscale;
  const it = settings.features.interrupt;
  const cellCount = m.gridSize * m.gridSize;

  return `<div class="page-inner">
    <section class="card">
      <div class="row" style="padding-top:0">
        <div class="row-main">
          <div class="row-title">限制功能总开关</div>
          <div class="row-desc">关掉之后所有时段都不生效，正在进行的限制会被记录为「提前结束」。</div>
        </div>
        ${toggleSwitch({ pressed: settings.enabled, act: 'set-bool', path: 'enabled', label: '限制功能总开关' })}
      </div>
      <div class="divider"></div>
      ${row({
        title: '开始前提醒',
        desc: '提前多少分钟弹出任务清单，让你在进入限制前写好要做的事。',
        control: stepper({ value: settings.prewarnMinutes, path: 'prewarnMinutes', min: 0, max: 60, step: 1, unit: ' 分', label: '开始前提醒' }),
      })}
    </section>

    <div class="section-label">每日重复的时间段</div>
    <section class="card">
      <div class="row" style="padding-top:0">
        <div class="row-main">
          <div class="row-title">时间表在「记录」页管理</div>
          <div class="row-desc">增删限制时段、改时间和星期，都移到「记录 → 限制时段」了。</div>
        </div>
        <button class="btn ghost small" data-act="nav" data-view="stats">去记录</button>
      </div>
    </section>

    <div class="section-label">任务与休息</div>
    <section class="card">
      ${row({
        title: '任务清单',
        desc: '进入限制时展示，可以逐项勾选，进度条实时显示完成度。',
        control: toggleSwitch({ pressed: t.enabled, act: 'set-bool', path: 'features.tasks.enabled', label: '任务清单' }),
      })}
      ${row({
        title: '达标后奖励休息',
        desc: '任务进度达到阈值后，设备恢复可用一段时间，休息结束自动回到限制。',
        control: toggleSwitch({ pressed: t.restEnabled, act: 'set-bool', path: 'features.tasks.restEnabled', label: '奖励休息' }),
      })}
      ${row({
        title: '达成阈值',
        desc: '每次限制只发放一次休息，避免反复刷时长。',
        control: segmented({
          value: t.restThresholdPercent,
          path: 'features.tasks.restThresholdPercent',
          label: '休息阈值',
          options: [
            { value: 50, label: '50%' },
            { value: 75, label: '75%' },
            { value: 100, label: '100%' },
          ],
        }),
      })}
      ${row({
        title: '休息时长',
        desc: '会自动截断到本次限制结束时间。',
        control: stepper({ value: t.restMinutes, path: 'features.tasks.restMinutes', min: 1, max: 180, step: 1, unit: ' 分', label: '休息时长' }),
      })}
    </section>

    <div class="section-label">数字矩阵小游戏</div>
    <section class="card">
      ${row({
        title: '解锁时弹数字矩阵',
        desc: '限制期间切回或点「我用手机了」时弹出，按升序点完才能继续。',
        control: toggleSwitch({ pressed: m.enabled, act: 'set-bool', path: 'features.matrix.enabled', label: '数字矩阵' }),
      })}
      ${row({
        title: '矩阵尺寸',
        desc: `${cellCount} 个格子`,
        control: segmented({
          value: m.gridSize,
          path: 'features.matrix.gridSize',
          label: '矩阵尺寸',
          options: [3, 4, 5, 6].map((n) => ({ value: n, label: `${n}×${n}` })),
        }),
      })}
      ${row({
        title: '最大数字',
        desc: `从 1–${m.maxNumber} 里抽 ${cellCount} 个数。数字越大越稀疏，越难扫。`,
        control: stepper({
          value: m.maxNumber,
          path: 'features.matrix.maxNumber',
          min: cellCount,
          max: MATRIX_LIMITS.maxNumber[1],
          step: 4,
          label: '最大数字',
        }),
      })}
      ${row({
        title: '单局限时',
        desc: '0 表示不限时。超时会重开一局。',
        control: stepper({ value: m.timeLimitSec, path: 'features.matrix.timeLimitSec', min: 0, max: 300, step: 5, unit: ' 秒', label: '单局限时' }),
      })}
      ${row({
        title: '容错次数',
        desc: '点错达到这个次数就重开。',
        control: stepper({ value: m.maxErrors, path: 'features.matrix.maxErrors', min: 1, max: 10, step: 1, unit: ' 次', label: '容错次数' }),
      })}
      ${row({
        title: '通关冷却',
        desc: '通关后多久内不再弹出，避免反复折腾。',
        control: stepper({ value: m.cooldownMinutes, path: 'features.matrix.cooldownMinutes', min: 0, max: 120, step: 5, unit: ' 分', label: '通关冷却' }),
      })}
    </section>

    <div class="section-label">灰度模式</div>
    <section class="card">
      ${row({
        title: '限制期间自动灰度',
        desc: '进入限制时把界面变灰，结束或休息时自动恢复。',
        control: toggleSwitch({ pressed: g.enabled, act: 'set-bool', path: 'features.grayscale.enabled', label: '自动灰度' }),
      })}
      ${row({
        title: '灰度强度',
        control: stepper({ value: g.intensityPercent, path: 'features.grayscale.intensityPercent', min: 0, max: 100, step: 10, unit: '%', label: '灰度强度' }),
      })}
      ${row({
        title: '同时压暗',
        desc: '夜间更省眼，但对可读性有影响。',
        control: stepper({ value: g.dimPercent, path: 'features.grayscale.dimPercent', min: 0, max: 60, step: 10, unit: '%', label: '压暗强度' }),
      })}
    </section>

    <div class="section-label">重要联系人提醒</div>
    <section class="card">
      ${row({
        title: '重要联系人消息提醒',
        desc: '名单里的人发来消息时响铃；限制期间还会自动暂停计时，避免错过重要信息。',
        control: toggleSwitch({ pressed: it.enabled, act: 'set-bool', path: 'features.interrupt.enabled', label: '重要联系人提醒' }),
      })}
      ${row({
        title: '自动暂停计时',
        desc: '暂停时解除灰度、狐狸休息；点「恢复计时」后结束时间自动顺延，不会少锁。',
        control: toggleSwitch({ pressed: it.autoPause, act: 'set-bool', path: 'features.interrupt.autoPause', label: '自动暂停计时' }),
      })}
      ${row({
        title: '连续响铃',
        desc: `每 ${Math.round(it.ringIntervalMs / 1000)} 秒响一次。`,
        control: stepper({ value: it.ringTimes, path: 'features.interrupt.ringTimes', min: 1, max: 10, step: 1, unit: ' 次', label: '连续响铃' }),
      })}
      ${row({
        title: '同一联系人冷却',
        desc: '冷却期内同一个人连发多条只响一次，避免刷屏。',
        control: stepper({ value: it.cooldownSeconds, path: 'features.interrupt.cooldownSeconds', min: 5, max: 600, step: 5, unit: ' 秒', label: '冷却' }),
      })}
      <div class="divider"></div>
      <p class="tiny" style="margin-bottom:8px">名单（${it.contacts.length}/50）</p>
      ${
        it.contacts.length
          ? `<div class="contact-list">${it.contacts
              .map((c) => {
                const meta = appMeta(c.app);
                return `<div class="contact-row">
                  <span class="app-badge" style="--app:${meta.color}">${esc(meta.name)}</span>
                  <span class="contact-name">${esc(c.name)}</span>
                  <button class="del" type="button" data-act="contact-del" data-id="${esc(c.id)}" aria-label="移除">×</button>
                </div>`;
              })
              .join('')}</div>`
          : `<div class="empty">名单还是空的<br /><span class="tiny">加上家人、老板、孩子老师这些不能错过的人</span></div>`
      }
      <div class="contact-add">
        <select class="input contact-app-select" data-act="contact-app" aria-label="选择应用">
          ${INTERRUPT_APPS.map((a) => `<option value="${a.id}" ${a.id === (ctx.ui.contactApp || 'wechat') ? 'selected' : ''}>${a.name}</option>`).join('')}
        </select>
        <input class="input" id="contact-name" data-focus="contact-name" type="text" maxlength="24"
          placeholder="备注名（与通知里显示的一致）" data-act="contact-name-key" />
        <button class="btn primary small" type="button" data-act="contact-add">添加</button>
      </div>
      <div class="hint warn" style="margin-top:12px">
        浏览器<b>读不到</b>微信 / QQ / 钉钉的消息（没有这个权限），需要宿主系统把通知送进来：<br />
        ${
          ctx.prod
            ? `<code>FoxLock.notify({ app: 'wechat', contact: '张老师' })</code><br />
               Android 侧用 NotificationListenerService 监听通知后调用（WebView 里 evaluateJavascript），
               桌面端可由浏览器扩展注入；接口说明见交付包 README「宿主集成」。`
            : `<code>GET http://127.0.0.1:7317/api/interrupt?app=wechat&amp;contact=张三</code><br />
               手机端可用 Tasker / 自建 NotificationListenerService 调用；Android 真机方案见 docs/DESIGN.md。`
        }
      </div>
      <button class="btn ghost block" style="margin-top:10px" data-act="contact-test">测试：响一次铃（限制期间同时暂停）</button>
    </section>

    <div class="section-label">小狐狸</div>
    <section class="card">
      <div class="row" style="padding-top:0">
        <div class="row-main">
          <div class="row-title">收集任务 <span class="tiny">始终启用</span></div>
          <div class="row-desc">限制开始时小狐狸开始收集羽毛和花朵。中途离开或切屏会失败并哭泣；坚持到结束才能收获花朵。</div>
        </div>
        <span class="pill-soft ok">已锁定</span>
      </div>
      ${row({
        title: '离开容忍时间',
        desc: '切屏多久之后才算"真的离开"。0 表示立刻判定失败。',
        control: stepper({ value: settings.fox.graceLeaveMs / 1000, path: 'fox.graceLeaveSeconds', min: 0, max: 60, step: 1, unit: ' 秒', label: '离开容忍时间' }),
      })}
      ${row({
        title: '提前结束需长按',
        desc: '防误触。按住按钮达到时长才会结束本次限制（记为提前结束，不发花）。',
        control: stepper({ value: settings.emergency.holdSeconds, path: 'emergency.holdSeconds', min: 1, max: 10, step: 1, unit: ' 秒', label: '长按时长' }),
      })}
    </section>

    <div class="section-label">界面与数据</div>
    <section class="card">
      ${row({
        title: '主题',
        control: segmented({
          value: settings.ui.theme,
          path: 'ui.theme',
          label: '主题',
          options: [
            { value: 'auto', label: '跟随系统' },
            { value: 'dark', label: '深色' },
            { value: 'light', label: '浅色' },
          ],
        }),
      })}
      ${row({
        title: '减少动效',
        desc: '关闭粒子与弹跳动画，省电、也更稳。',
        control: toggleSwitch({ pressed: settings.ui.reduceMotion, act: 'set-bool', path: 'ui.reduceMotion', label: '减少动效' }),
      })}
      ${row({
        title: '音效',
        desc: '开始、达标、通关、结算的提示音。',
        control: toggleSwitch({ pressed: settings.ui.sound, act: 'set-bool', path: 'ui.sound', label: '音效' }),
      })}
      ${row({
        title: '背景音乐',
        desc: ctx.bgm && ctx.bgm.broken
          ? '这次构建没有内联音频（--no-bgm），所以听不到音乐——其余功能不受影响。'
          : '首页 / 记录 / 收藏 / 设置四个页面循环播放，进入限制、休息、结算时自动淡出。',
        control: segmented({
          value: (ctx.bgm && ctx.bgm.key) || 'mid',
          act: 'bgm-set',
          label: '背景音乐音量',
          options: [
            { value: 'off', label: '关' },
            { value: 'low', label: '20%' },
            { value: 'mid', label: '30%' },
            { value: 'high', label: '50%' },
          ],
        }),
      })}
      <div class="divider"></div>
      <div class="row">
        <div class="row-main">
          <div class="row-title">通知提醒</div>
          <div class="row-desc">当前权限：${esc(ctx.notifyPermission)}${caps.notifications ? '' : '（此浏览器不支持）'}</div>
        </div>
        <button class="btn ghost small" data-act="notify-permission" ${caps.notifications ? '' : 'disabled'}>申请</button>
      </div>
      <div class="row">
        <div class="row-main">
          <div class="row-title">本地数据</div>
          <div class="row-desc">${ctx.storageAvailable ? '设置、收藏与记录都存在本机 localStorage。' : '⚠️ 存储不可用，本次修改只在内存里，关掉页面就没了。'}</div>
        </div>
        <button class="btn ${ctx.ui?.confirm?.key === 'reset-settings' ? 'danger' : 'ghost'} small" data-act="reset-settings">${
          ctx.ui?.confirm?.key === 'reset-settings' ? '确认恢复默认？' : '恢复默认'
        }</button>
      </div>
      <div class="row">
        <div class="row-main">
          <div class="row-title">版本</div>
          <div class="row-desc">v${esc(ctx.version || '?')} · ${ctx.prod ? '评审交付版（静态单文件，无需服务）' : '原型 / 开发版'}</div>
        </div>
        <span class="pill-soft ${ctx.prod ? 'ok' : ''}">${ctx.prod ? 'DELIVERY' : 'DEV'}</span>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h3>浏览器能做到什么</h3></div>
      <div class="hint warn">
        浏览器<b>不能</b>拦截其他 App、不能做系统级灰度、也不能阻止你关掉页面或切走 —— 这些需要 Android 的悬浮窗 / 无障碍 / WRITE_SECURE_SETTINGS，见 docs/DESIGN.md。<br />
        在网页里，灰度是本应用界面的灰度，切屏检测依赖浏览器可见性事件。
      </div>
    </section>
  </div>`;
}
