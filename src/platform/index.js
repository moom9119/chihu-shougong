/**
 * platform/index.js —— 平台接口说明（TypeScript 风格的 JSDoc 契约）。
 *
 * Android 端（Kotlin）需要实现同名能力，见 docs/DESIGN.md 的"权限与系统限制"。
 *
 * @typedef {Object} PlatformCapabilities
 * @property {'native'|'simulated'|'none'} grayscale
 * @property {boolean} appBlocking
 * @property {boolean} systemWide
 * @property {boolean} notifications
 * @property {boolean} wakeLock
 * @property {boolean} vibration
 *
 * @typedef {Object} Platform
 * @property {PlatformCapabilities} caps
 * @property {(on:boolean, opts?:{intensityPercent?:number, dimPercent?:number}) => void} setGrayscale
 * @property {() => void} startPresence
 * @property {() => void} stopPresence
 * @property {() => Promise<void>} requestWakeLock
 * @property {() => void} releaseWakeLock
 * @property {(title:string, body:string) => void} notify
 * @property {() => Promise<string>} requestNotifications
 * @property {() => string} notificationPermission
 * @property {() => void} unlockAudio
 * @property {(name:string) => void} sound
 * @property {(pattern?:number|number[]) => void} vibrate
 */

export const PLATFORM_TARGETS = {
  web: {
    grayscale: 'simulated',
    note: '页面级灰度：只影响本应用界面，模拟设备灰度体验。',
  },
  android: {
    grayscale: 'native',
    note: 'Settings.Secure 的 accessibility_display_daltonizer(-enabled)，需要 WRITE_SECURE_SETTINGS（adb 授权）。',
  },
  desktop: {
    grayscale: 'native',
    note: 'Windows 可用 Magnification API 或 DWM 色彩矩阵实现全屏灰度。',
  },
};
