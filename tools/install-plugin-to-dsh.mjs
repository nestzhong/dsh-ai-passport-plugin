#!/usr/bin/env node
/**
 * 把插件以**源码即生效代码**的方式装进 DSH 的某个 profile（macOS / Windows 通用）。
 *
 * 为什么必须是链接而不是 `pnpm add file:...`：pnpm 会**拷贝**一份到 node_modules，
 * 于是"磁盘上的源码"与"宿主实际加载的目录"变成两份。改了源码却以为生效、实际跑的
 * 是旧拷贝 —— 这个坑真实发生过，让三轮排查建立在错误前提上。
 *
 * 链接策略按平台自动选择（也可用 --copy 强制）：
 *   - macOS / Linux → 符号链接（ln -s 等价物）
 *   - Windows       → 目录 junction（**无需**管理员权限或开发者模式）
 *     junction 也失败（机器策略禁止）→ 降级为复制，并写 .dsh-passport-install.json
 *     标记 copy 模式，每次安装时提醒"改源码需重装"。
 *
 * DSH profile 目录 = <dshHome>/profiles/<name>，dshHome 默认 ~/.dsh
 * （与 DSH 宿主自身的解析规则一致：OS home + .dsh），可用环境变量 DSH_HOME 覆盖。
 *
 * ★ 光链接进 node_modules 还不够：DSH 只会按 profile package.json 里的
 *   `dsh.profile.bundles` 顺序叠加 bundle patch 层，没写进列表的包**不会被加载**
 *   （现象：插件装好了却看不到任何面板/挂件）。所以安装时还必须保证
 *   bundles 里有一项 `dsh-ai-passport` —— 这一步是幂等的，已存在就不动文件。
 *
 * 用法：
 *   node tools/install-plugin-to-dsh.mjs [profile ...]   # 默认 desktop
 *   node tools/install-plugin-to-dsh.mjs --copy web      # 强制复制模式
 *   DSH_HOME=~/my-dsh node tools/install-plugin-to-dsh.mjs
 *
 * 旧入口 tools/install-plugin-to-dsh.sh / .ps1 保留，均转调本文件。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGIN_SRC = path.join(REPO_ROOT, 'packages', 'dsh-ai-passport')
export const BUNDLE_NAME = 'dsh-ai-passport'
/** DSH 的语音识别子系统 bundle（服务 + 本地 SenseVoice 提供者 + 设置项）。 */
export const VOICE_BUNDLE_NAME = '@deepseek-ai/dsh-experimental-voice-input-bundle'
const INSTALL_MARKER = '.dsh-passport-install.json'

/** copy 模式只带走运行所需内容；node_modules 在 profile 层，audio 是联调产物。 */
const COPY_ENTRIES = ['package.json', 'lib', 'cordis.patch.yml', 'README.md']

/** 解析 DSH 家目录：DSH_HOME 优先，否则 OS home + .dsh（win/mac 同一规则）。 */
export function resolveDshHome(env = process.env, homedir = os.homedir()) {
  const raw = env.DSH_HOME
  return raw ? path.resolve(raw) : path.join(homedir, '.dsh')
}

/**
 * 平台 → 链接类型。Windows 用 junction：目录联接由普通用户直接创建，
 * 而 symlink 在 Windows 上默认要求管理员或开发者模式。
 */
export function linkModeFor(platform = process.platform) {
  return platform === 'win32' ? 'junction' : 'dir'
}

/**
 * 把插件登记进 profile 的 `dsh.profile.bundles`（幂等）。
 *
 * DSH 的配置树完全由这几层拼出来：bundles 列表里的每个包 → profile 的
 * cordis.patch.yml → home 级 cordis.patch.yml → --patch 覆盖。
 * 不在 bundles 里的包**不会**被加载，哪怕它就在 node_modules 下、
 * 哪怕它的 package.json 有 `dsh.bundle.patch`。
 *
 * 返回 { status: 'added' | 'present' | 'skipped' }，skipped 带 reason。
 * 只碰 `dsh.profile.bundles` 这一个字段，其余键按原样保留。
 */
export function ensureBundleEntry(options) {
  const { profileDir, bundleName = BUNDLE_NAME, logger = () => {} } = options
  const pkgPath = path.join(profileDir, 'package.json')
  if (!fs.existsSync(pkgPath)) {
    return { status: 'skipped', reason: `profile 缺少 package.json：${pkgPath}` }
  }

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    // 解析失败时不能瞎写 —— 覆盖一个坏文件比漏注册更糟。
    return { status: 'skipped', reason: `profile package.json 解析失败：${error.message}` }
  }

  pkg.dsh ??= {}
  pkg.dsh.profile ??= {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (bundles.includes(bundleName)) return { status: 'present' }

  pkg.dsh.profile.bundles = [...bundles, bundleName]
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  logger(`   已把 ${bundleName} 加入 profile package.json 的 dsh.profile.bundles`)
  return { status: 'added' }
}

/**
 * 读 profile 的 bundles 列表，判断某个包是否已登记（只读，不写文件）。
 * package.json 缺失或解析失败一律当"没有"，调用方只用来决定提示。
 */
export function profileHasBundle(profileDir, bundleName = BUNDLE_NAME) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(bundleName)
  } catch {
    return false
  }
}

/**
 * 判断语音识别服务是否已挂载：看 profile patch 层（以及可选的 home 级 patch）
 * 有没有 insert 服务本体。只做文本级识别，误判的代价只是少/多打一条提示。
 */
export function profileHasSpeech(profileDir, extraPatchPaths = []) {
  const files = [path.join(profileDir, 'cordis.patch.yml'), ...extraPatchPaths]
  const needle = /name:\s*['"]?@deepseek-ai\/dsh-experimental-speech-to-text['"]?\s*$/m
  return files.some((file) => {
    try {
      return needle.test(fs.readFileSync(file, 'utf8'))
    } catch {
      return false
    }
  })
}

/**
 * 装一个 profile。返回 { profile, mode, target, bundle } 或 { profile, skipped, reason }。
 *
 * 依赖全部可注入（symlink/copy/logger），以便单元测试覆盖 Windows 分支
 * 而不依赖真机权限模型。
 */
export function installProfile(options) {
  const {
    pluginSrc = PLUGIN_SRC,
    dshHome,
    profile,
    platform = process.platform,
    forceCopy = false,
    logger = () => {},
    symlink = fs.symlinkSync,
    copy = defaultCopy,
    writeMarker = defaultWriteMarker,
    registerBundle = ensureBundleEntry,
  } = options

  const dir = path.join(dshHome, 'profiles', profile)
  if (!fs.existsSync(dir)) {
    return { profile, skipped: true, reason: `profile 不存在：${dir}` }
  }
  if (!fs.existsSync(path.join(pluginSrc, 'package.json'))) {
    throw new Error(`找不到插件源码：${pluginSrc}`)
  }

  const nodeModules = path.join(dir, 'node_modules')
  fs.mkdirSync(nodeModules, { recursive: true })
  const target = path.join(nodeModules, 'dsh-ai-passport')

  // 先清掉旧安装（符号链接 / junction / 复制目录都走这里）。
  // fs.rmSync 对链接只删链接本身、不动源码目录，安全。
  fs.rmSync(target, { recursive: true, force: true })

  let mode
  if (forceCopy) {
    mode = 'copy'
  } else {
    const linkType = linkModeFor(platform)
    try {
      // Windows：'junction'；POSIX：'dir'。两者都只在目录上合法。
      symlink(pluginSrc, target, linkType)
      mode = linkType === 'junction' ? 'junction' : 'symlink'
    } catch (error) {
      if (platform !== 'win32') throw error
      logger(`   ⚠ junction 创建失败（${error.code ?? error.message}），降级为复制`)
      mode = 'copy'
    }
  }

  if (mode === 'copy') {
    copy(pluginSrc, target)
    writeMarker(target, { mode, source: pluginSrc, installedAt: new Date().toISOString() })
    logger('   ⚠ copy 模式：改源码**不会**生效，改完需重跑本命令')
  }

  // noble 是原生模块，装在 profile 层（被 hoist），插件目录里不需要。
  const noble = path.join(nodeModules, '@stoprocent', 'noble')
  if (!fs.existsSync(noble)) {
    // 只是提示：桥进程按真实源码路径向上查找依赖，仓库根的 node_modules 也能解析到。
    logger('   ⚠ 未找到 @stoprocent/noble（profile 层）—— 若仓库根也没装，BLE 将不可用：在仓库根 npm install')
  }

  // Linux（树莓派等）上 BLE 能不能用，取决于"后端 + 权限"这一对：
  //   dbus —— 走 BlueZ 的 D-Bus，普通用户即可扫描（插件已默认选它，需要 dbus-next）
  //   hci  —— raw HCI socket，必须 root 或 CAP_NET_RAW，否则扫描静默卡死
  // 装完不提醒这一条，用户看到的现象是"点扫描并连接，一直转圈"，极难自查。
  if (platform === 'linux') {
    const hasDbusNext =
      fs.existsSync(path.join(nodeModules, 'dbus-next')) ||
      fs.existsSync(path.join(REPO_ROOT, 'node_modules', 'dbus-next'))
    if (hasDbusNext) {
      logger('   Linux：BLE 将走 BlueZ D-Bus 后端（普通用户可用，无需 root）')
    } else {
      logger('   ⚠ Linux：没找到 dbus-next，会退回 raw HCI 后端；非 root 下扫不到设备')
      logger('      修复：在仓库根执行 npm install（dbus-next 是可选依赖，随 npm install 一起装）')
    }
    if (!fs.existsSync('/sys/class/bluetooth')) {
      logger('   ⚠ 未发现蓝牙适配器（/sys/class/bluetooth 不存在）：确认硬件与 bluez 已启用')
    }
  }

  // 链接只是"让包可解析"；能不能被加载取决于 bundles 列表。
  const bundle = registerBundle({ profileDir: dir, logger })

  // 语音识别是 DSH 的可选子系统，默认不挂。它没开时插件能装、界面也能开，
  // 但语音区会一直提示"ctx.speechToText 不存在"。
  //
  // ★ 不要直接加 @deepseek-ai/dsh-experimental-voice-input-bundle：它还会挂
  //   client-ui-voice-input，在 desktop profile 上激活失败会让整个 web boot
  //   起不来（"1 entry did not activate"）。正确做法是在 profile 的
  //   cordis.patch.yml 里只 insert host 侧两个条目，见 README「快速开始」。
  if (!profileHasSpeech(dir, [path.join(dshHome, 'cordis.patch.yml')])) {
    logger('   ⚠ 语音识别未启用（挂在 host 侧的 speech-to-text 服务不在 profile 里）')
    logger('      → 需要设备语音输入时，按 README 往 cordis.patch.yml 追加两个 insert 条目后重启 DSH')
  }

  return { profile, mode, target, bundle }
}

function defaultCopy(src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of COPY_ENTRIES) {
    const from = path.join(src, entry)
    if (!fs.existsSync(from)) continue
    fs.cpSync(from, path.join(dest, entry), {
      recursive: true,
      filter: (p) => !/[\\/](node_modules|__pycache__)([\\/]|$)/.test(p) && !p.endsWith('.DS_Store'),
    })
  }
}

function defaultWriteMarker(target, info) {
  fs.writeFileSync(path.join(target, INSTALL_MARKER), `${JSON.stringify(info, null, 2)}\n`)
}

function usage() {
  console.log(`用法：node tools/install-plugin-to-dsh.mjs [选项] [profile ...]   默认 desktop

每装一个 profile 会做两件事（缺一不可）：
  1. 链接 node_modules/dsh-ai-passport -> 本仓库源码
  2. 把 dsh-ai-passport 登记进 profile package.json 的 dsh.profile.bundles
     （幂等；首次登记后需重启 DSH 才会加载）

选项：
  --copy      强制复制模式（不建链接；改源码后需重装）
  -h, --help  显示本帮助

环境变量：
  DSH_HOME    DSH 家目录（默认 ~/.dsh，Windows 即 %USERPROFILE%\\.dsh）`)
}

function main(argv) {
  const profiles = []
  let forceCopy = false
  for (const arg of argv) {
    if (arg === '--copy') forceCopy = true
    else if (arg === '-h' || arg === '--help') { usage(); return 0 }
    else if (arg.startsWith('-')) { console.error(`未知参数：${arg}`); usage(); return 2 }
    else profiles.push(arg)
  }
  if (profiles.length === 0) profiles.push('desktop')

  if (!fs.existsSync(path.join(PLUGIN_SRC, 'package.json'))) {
    console.error(`找不到插件源码：${PLUGIN_SRC}`)
    return 1
  }

  const dshHome = resolveDshHome()
  console.log(`DSH 家目录：${dshHome}（平台：${process.platform}）`)

  let installed = 0
  for (const profile of profiles) {
    console.log(`== profile: ${profile}`)
    const result = installProfile({ dshHome, profile, forceCopy, logger: (m) => console.log(m) })
    if (result.skipped) {
      console.log(`   跳过：${result.reason}`)
      continue
    }
    installed += 1
    const label = { junction: '已链接（junction）', symlink: '已链接（symlink）', copy: '已复制' }[result.mode]
    console.log(`   ${label} node_modules/dsh-ai-passport -> ${PLUGIN_SRC}`)
    if (result.bundle?.status === 'skipped') {
      console.log(`   ⚠ 未能登记 bundle：${result.bundle.reason}`)
      console.log('      → 插件仍不会被加载。请在 profile package.json 的 dsh.profile.bundles 里手工加入 dsh-ai-passport')
    } else if (result.bundle?.status === 'added') {
      console.log('   完成。首次登记需要**重启 DSH** 才会加载（bundles 只在启动时读取）。')
    } else {
      console.log('   完成。改源码后**无需再同步**；宿主侧改动仍需重启 DSH 生效。')
    }
  }

  if (installed === 0) {
    console.error('没有任何 profile 被安装。确认 DSH 客户端已初始化（或用 DSH_HOME 指向正确目录）。')
    return 1
  }
  return 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(main(process.argv.slice(2)))
}
