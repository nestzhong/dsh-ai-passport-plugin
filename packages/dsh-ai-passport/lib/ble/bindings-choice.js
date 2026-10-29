/**
 * Linux 上 noble 后端的默认选择。
 *
 * noble 在 Linux 有两个互斥后端，选错的表现差别极大：
 *
 *   hci  —— 直接开 raw HCI socket。需要 root 或 CAP_NET_RAW。
 *           普通用户下适配器状态会一直停在 `unknown`，`startScanning()`
 *           既不抛错也不开始扫描（树莓派 5 / Debian 13 / BlueZ 5.82 实测），
 *           用户看到的就是"点了扫描并连接，然后一直转圈，扫不到任何设备"。
 *   dbus —— 走 BlueZ 的 D-Bus 接口（org.bluez）。普通用户直接可用，
 *           还能从广播里拿到设备名（hci 后端拿不到 localName）；
 *           代价是依赖纯 JS 的 dbus-next。
 *
 * 所以 Linux 上**默认优先 dbus**：本包把 dbus-next 列为可选依赖，装了就用。
 * 用户显式设置 `NOBLE_BINDINGS` 时完全听用户的（hci / mac / win 都合法）——
 * 这条兜底路径留给极端环境（没有 session D-Bus、只能用 root 跑 hci）。
 *
 * 为什么必须在 import noble 之前决定：noble 在**模块加载时**读这个环境变量，
 * 之后再设就没用了。插件的配置解析发生在宿主进程里、时间点更晚，而桥子进程
 * 只能通过环境变量接收，所以选择逻辑放在这里、由桥进程自己在 require 前跑一遍。
 */

import { createRequire } from 'node:module'

/** noble 读取后端的那个环境变量名。 */
export const BINDING_ENV = 'NOBLE_BINDINGS'

const requireFromHere = createRequire(import.meta.url)

/** 默认的模块可解析性探测：探测失败一律当"没有"，不让探测本身成为失败源。 */
function defaultCanResolve(name) {
  try {
    // 用 resolve 而不是 require：只需要知道"能不能解析到"，
    // 不需要真的把模块跑起来（dbus-next 加载时会连 session bus）。
    requireFromHere.resolve(name)
    return true
  } catch {
    return false
  }
}

/**
 * 选出本次桥进程该用的后端。
 *
 * @param {object} [options]
 * @param {string} [options.platform] 依赖注入，测试用
 * @param {Record<string,string|undefined>} [options.env] 依赖注入，测试用
 * @param {(name:string)=>boolean} [options.canResolve] 依赖注入，测试用
 * @returns {{ backend: string|null, applies: boolean, reason: string, note: string }}
 *   backend 为 null 表示"不干预，交给 noble 自己按平台选"；
 *   applies 表示调用方需要把 backend 写进环境变量（显式设置时已经是设好的）。
 */
export function selectBindings(options = {}) {
  const {
    platform = process.platform,
    env = process.env,
    canResolve = defaultCanResolve,
  } = options

  const requested = String(env?.[BINDING_ENV] ?? '').trim()
  if (requested) {
    return {
      backend: requested,
      applies: false,
      reason: 'explicit',
      note: `使用显式指定的后端（${BINDING_ENV}=${requested}）`,
    }
  }

  // macOS / Windows 有原生后端，noble 自己选得对，不要干预。
  if (platform !== 'linux') {
    return { backend: null, applies: false, reason: 'platform', note: '' }
  }

  if (canResolve('dbus-next')) {
    return {
      backend: 'dbus',
      applies: true,
      reason: 'linux-dbus',
      note: 'Linux 默认走 BlueZ D-Bus 后端（普通用户即可扫描，无需 root）',
    }
  }

  return {
    backend: null,
    applies: false,
    reason: 'linux-no-dbus',
    note:
      '没装 dbus-next，退回 raw HCI 后端；非 root 下适配器会停在 unknown、扫描不动。' +
      '修复：npm install dbus-next（推荐），或给 node 加权限 sudo setcap cap_net_raw+eip $(which node) 后以 hci 后端运行',
  }
}

/**
 * 把选择结果写进环境变量 —— **必须在 import noble 之前调用**。
 * 只在自己选了后端、且用户没有显式指定时才写。
 *
 * @returns {boolean} 是否真的改了环境变量
 */
export function applyBindings(choice, env = process.env) {
  if (!choice?.applies || !choice.backend) return false
  if (String(env?.[BINDING_ENV] ?? '').trim()) return false
  env[BINDING_ENV] = choice.backend
  return true
}
