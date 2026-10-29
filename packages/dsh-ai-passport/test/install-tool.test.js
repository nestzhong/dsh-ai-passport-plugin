/**
 * 跨平台安装器（tools/install-plugin-to-dsh.mjs）的单元测试。
 *
 * 重点是**不依赖真机权限模型**地覆盖 Windows 分支：链接策略的平台选择、
 * junction 失败时的 copy 降级、copy 模式的标记文件，都通过注入假 symlink /
 * 真临时目录验证。Windows 上真跑一遍的验收留给用户反馈清单（docs/08）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PLUGIN_SRC,
  resolveDshHome,
  linkModeFor,
  installProfile,
  ensureBundleEntry,
  profileHasBundle,
  profileHasSpeech,
} from '../../../tools/install-plugin-to-dsh.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-install-'))
}

function makeFakeProfile(home, name = 'desktop') {
  const dir = path.join(home, 'profiles', name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('resolveDshHome：DSH_HOME 覆盖，默认 home/.dsh（win/mac 同一规则）', () => {
  assert.equal(
    resolveDshHome({ DSH_HOME: '/custom/dsh' }, '/home/u'),
    path.resolve('/custom/dsh'),
  )
  assert.equal(resolveDshHome({}, '/home/u'), path.join('/home/u', '.dsh'))
  // Windows 风格 home 也只做拼接，不假设分隔符
  assert.equal(resolveDshHome({}, 'C:\\Users\\u'), path.join('C:\\Users\\u', '.dsh'))
})

test('linkModeFor：Windows 用 junction（免管理员），其余用 dir 符号链接', () => {
  assert.equal(linkModeFor('win32'), 'junction')
  assert.equal(linkModeFor('darwin'), 'dir')
  assert.equal(linkModeFor('linux'), 'dir')
})

test('installProfile：Windows 分支传 junction 类型给 symlink', () => {
  const home = makeHome()
  makeFakeProfile(home)
  const calls = []
  const result = installProfile({
    dshHome: home,
    profile: 'desktop',
    platform: 'win32',
    symlink: (src, dest, type) => {
      calls.push({ src, dest, type })
      fs.symlinkSync(src, dest, 'dir') // 测试宿主是 macOS，用 dir 落地即可
    },
  })
  assert.equal(result.mode, 'junction')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].type, 'junction')
  assert.equal(calls[0].src, PLUGIN_SRC)
})

test('installProfile：junction 失败（权限/策略）→ 降级 copy + 写标记文件', () => {
  const home = makeHome()
  makeFakeProfile(home)
  const logs = []
  const result = installProfile({
    dshHome: home,
    profile: 'desktop',
    platform: 'win32',
    logger: (m) => logs.push(m),
    symlink: () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    },
  })
  assert.equal(result.mode, 'copy')
  const target = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-ai-passport')
  assert.ok(fs.existsSync(path.join(target, 'package.json')), 'copy 模式要带 package.json')
  assert.ok(fs.existsSync(path.join(target, 'lib', 'index.js')), 'copy 模式要带 lib/')
  const marker = JSON.parse(
    fs.readFileSync(path.join(target, '.dsh-passport-install.json'), 'utf8'),
  )
  assert.equal(marker.mode, 'copy')
  assert.equal(marker.source, PLUGIN_SRC)
  assert.ok(logs.some((line) => line.includes('降级为复制')))
  assert.ok(logs.some((line) => line.includes('copy 模式')))
})

test('installProfile：macOS 分支走 dir 符号链接，重装会清掉旧目标', () => {
  const home = makeHome()
  makeFakeProfile(home)
  const first = installProfile({ dshHome: home, profile: 'desktop', platform: 'darwin' })
  assert.equal(first.mode, 'symlink')
  const target = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-ai-passport')
  assert.ok(fs.lstatSync(target).isSymbolicLink())

  // 造一个"旧的 copy 安装"，重装必须整体替换且不伤源码目录
  fs.rmSync(target, { recursive: true, force: true })
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(path.join(target, 'stale.txt'), 'x')
  const second = installProfile({ dshHome: home, profile: 'desktop', platform: 'darwin' })
  assert.equal(second.mode, 'symlink')
  assert.ok(fs.lstatSync(target).isSymbolicLink())
  assert.ok(!fs.existsSync(path.join(target, 'stale.txt')), '旧安装必须被清掉')
  assert.ok(fs.existsSync(path.join(PLUGIN_SRC, 'package.json')), '源码目录不受影响')
})

test('installProfile：profile 不存在时跳过（不算失败）', () => {
  const home = makeHome()
  const result = installProfile({ dshHome: home, profile: 'nope', platform: 'darwin' })
  assert.equal(result.skipped, true)
  assert.match(result.reason, /profile 不存在/)
})

test('copy 模式不携带 node_modules 与 audio 产物', () => {
  const home = makeHome()
  makeFakeProfile(home)
  installProfile({
    dshHome: home,
    profile: 'desktop',
    platform: 'win32',
    forceCopy: true,
  })
  const target = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-ai-passport')
  assert.ok(!fs.existsSync(path.join(target, 'node_modules')), 'node_modules 不进 copy')
  assert.ok(!fs.existsSync(path.join(target, 'audio')), 'audio 联调产物不进 copy')
  assert.ok(fs.existsSync(path.join(target, 'cordis.patch.yml')))
})

test('安装器源码与本测试同处一个仓库布局（防路径漂移）', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'tools', 'install-plugin-to-dsh.mjs')))
})

// —— bundles 登记：链接可解析 ≠ 会被加载 ——
// 真实故障：插件链接进 node_modules 却看不到任何界面，因为 DSH 只按
// profile package.json 的 dsh.profile.bundles 叠加 patch 层。

function writeProfilePkg(dir, pkg) {
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)
  return path.join(dir, 'package.json')
}

test('ensureBundleEntry：首次安装把 dsh-ai-passport 追加到 bundles 末尾', () => {
  const dir = makeFakeProfile(makeHome())
  const pkgPath = writeProfilePkg(dir, {
    name: 'dsh-profile-desktop',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-context'] } },
  })
  const logs = []
  const result = ensureBundleEntry({ profileDir: dir, logger: (m) => logs.push(m) })
  assert.equal(result.status, 'added')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  assert.deepEqual(pkg.dsh.profile.bundles, [
    '@deepseek-ai/dsh-base',
    'dsh-context',
    'dsh-ai-passport',
  ])
  assert.equal(pkg.name, 'dsh-profile-desktop', '其它字段必须原样保留')
  assert.equal(pkg.private, true)
  assert.ok(logs.some((line) => line.includes('dsh.profile.bundles')))
})

test('ensureBundleEntry：幂等 —— 已登记时不动文件（不重排、不重写）', () => {
  const dir = makeFakeProfile(makeHome())
  const pkgPath = writeProfilePkg(dir, {
    dsh: { profile: { bundles: ['dsh-ai-passport', 'dsh-context'] } },
  })
  const before = fs.readFileSync(pkgPath, 'utf8')
  const result = ensureBundleEntry({ profileDir: dir })
  assert.equal(result.status, 'present')
  assert.equal(fs.readFileSync(pkgPath, 'utf8'), before, '已存在时文件内容必须逐字不变')
})

test('ensureBundleEntry：bundles 缺失/非数组时补一个合法数组', () => {
  for (const dsh of [{}, { profile: {} }, { profile: { bundles: 'oops' } }, undefined]) {
    const dir = makeFakeProfile(makeHome())
    const pkgPath = writeProfilePkg(dir, { name: 'x', dsh })
    assert.equal(ensureBundleEntry({ profileDir: dir }).status, 'added')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    assert.deepEqual(pkg.dsh.profile.bundles, ['dsh-ai-passport'], `dsh=${JSON.stringify(dsh)}`)
  }
})

test('ensureBundleEntry：package.json 坏了就跳过，绝不覆盖用户文件', () => {
  const dir = makeFakeProfile(makeHome())
  const pkgPath = path.join(dir, 'package.json')
  const broken = '{ "dsh": { "profile": '
  fs.writeFileSync(pkgPath, broken)
  const result = ensureBundleEntry({ profileDir: dir })
  assert.equal(result.status, 'skipped')
  assert.match(result.reason, /解析失败/)
  assert.equal(fs.readFileSync(pkgPath, 'utf8'), broken)
})

test('installProfile：装完后 profile 的 bundles 里必然含插件（否则面板不出现）', () => {
  const home = makeHome()
  const dir = makeFakeProfile(home)
  writeProfilePkg(dir, { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
  const result = installProfile({ dshHome: home, profile: 'desktop', platform: 'darwin' })
  assert.equal(result.mode, 'symlink')
  assert.equal(result.bundle.status, 'added')
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.ok(pkg.dsh.profile.bundles.includes('dsh-ai-passport'))
})

// —— 语音识别是独立可选子系统：必须挂在 host 侧，且不能连带客户端 UI ——

test('profileHasBundle：只读判断，缺文件/坏 JSON 一律当没有', () => {
  const dir = makeFakeProfile(makeHome())
  assert.equal(profileHasBundle(dir, 'x'), false, '没有 package.json → false')

  writeProfilePkg(dir, { dsh: { profile: { bundles: ['dsh-context'] } } })
  assert.equal(profileHasBundle(dir, 'dsh-context'), true)
  assert.equal(profileHasBundle(dir, 'dsh-ai-passport'), false)

  fs.writeFileSync(path.join(dir, 'package.json'), '{ broken')
  assert.equal(profileHasBundle(dir, 'dsh-context'), false, '坏 JSON → false，不抛')
})

test('profileHasSpeech：只认 insert 里的 speech-to-text 服务本体', () => {
  const dir = makeFakeProfile(makeHome())
  assert.equal(profileHasSpeech(dir), false, '没有 patch 文件 → false')

  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    '- insert:\n    - id: speech-to-text-sensevoice\n      name: "@deepseek-ai/dsh-experimental-speech-to-text-sensevoice"\n',
  )
  assert.equal(profileHasSpeech(dir), false, '只有提供者、没有服务本体 → 仍算没开')

  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    "- insert:\n    - id: speech-to-text\n      name: '@deepseek-ai/dsh-experimental-speech-to-text'\n      config:\n        defaultProvider: sensevoice-local\n",
  )
  assert.equal(profileHasSpeech(dir), true)
})

test('profileHasSpeech：也看 home 级 patch 层', () => {
  const dir = makeFakeProfile(makeHome())
  const homePatch = path.join(makeHome(), 'cordis.patch.yml')
  fs.writeFileSync(
    homePatch,
    '- insert:\n    - id: speech-to-text\n      name: "@deepseek-ai/dsh-experimental-speech-to-text"\n',
  )
  assert.equal(profileHasSpeech(dir, [homePatch]), true)
})

test('installProfile：语音没开时提示，且不擅自替用户加 voice-input-bundle', () => {
  const home = makeHome()
  const dir = makeFakeProfile(home)
  writeProfilePkg(dir, { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
  const logs = []
  installProfile({
    dshHome: home,
    profile: 'desktop',
    platform: 'darwin',
    logger: (m) => logs.push(m),
  })
  assert.ok(
    logs.some((line) => line.includes('语音识别未启用')),
    `应提示语音未启用，实际日志：\n${logs.join('\n')}`,
  )
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(
    pkg.dsh.profile.bundles,
    ['@deepseek-ai/dsh-base', 'dsh-ai-passport'],
    '安装器不擅自加语音 bundle（那会让 client-ui-voice-input 拖垮 boot）',
  )
})

test('installProfile：语音已开时不再提示', () => {
  const home = makeHome()
  const dir = makeFakeProfile(home)
  writeProfilePkg(dir, { dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } })
  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    '- insert:\n    - id: speech-to-text\n      name: "@deepseek-ai/dsh-experimental-speech-to-text"\n',
  )
  const logs = []
  installProfile({
    dshHome: home,
    profile: 'desktop',
    platform: 'darwin',
    logger: (m) => logs.push(m),
  })
  assert.ok(!logs.some((line) => line.includes('语音识别未启用')))
})
