/**
 * Linux 后端选择策略的单元测试。
 *
 * 这些用例锁的是树莓派实战踩出来的两个坑：
 *   1. Linux 上不能默认用 hci（非 root 下静默扫不到设备）；
 *   2. 用户显式设了 NOBLE_BINDINGS 时，任何"智能默认"都不许覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { selectBindings, applyBindings, BINDING_ENV } from './bindings-choice.js'

const yes = () => true
const no = () => false

test('Linux + 有 dbus-next：默认选 dbus，并要求写进环境变量', () => {
  const env = {}
  const choice = selectBindings({ platform: 'linux', env, canResolve: yes })
  assert.equal(choice.backend, 'dbus')
  assert.equal(choice.applies, true)
  assert.equal(choice.reason, 'linux-dbus')
  assert.match(choice.note, /D-Bus/)
})

test('Linux + 没 dbus-next：不干预 noble，但提示 hci 需要 root/CAP_NET_RAW', () => {
  const choice = selectBindings({ platform: 'linux', env: {}, canResolve: no })
  assert.equal(choice.backend, null)
  assert.equal(choice.applies, false)
  assert.equal(choice.reason, 'linux-no-dbus')
  // 提示必须给出可执行的修复动作，而不是只说"不可用"
  assert.match(choice.note, /dbus-next/)
  assert.match(choice.note, /setcap|root/)
})

test('macOS / Windows 不干预，交给 noble 自己选平台后端', () => {
  for (const platform of ['darwin', 'win32']) {
    const choice = selectBindings({ platform, env: {}, canResolve: yes })
    assert.equal(choice.backend, null, platform)
    assert.equal(choice.applies, false, platform)
    assert.equal(choice.reason, 'platform', platform)
  }
})

test('显式设置优先：即使用户选了 hci 也不改写', () => {
  const env = { [BINDING_ENV]: 'hci' }
  const choice = selectBindings({ platform: 'linux', env, canResolve: yes })
  assert.equal(choice.backend, 'hci')
  assert.equal(choice.applies, false)
  assert.equal(choice.reason, 'explicit')
  assert.match(choice.note, /hci/)
})

test('显式值带空格也能识别（shell 里手滑的常见形态）', () => {
  const choice = selectBindings({ platform: 'linux', env: { [BINDING_ENV]: ' hci ' }, canResolve: yes })
  assert.equal(choice.backend, 'hci')
  assert.equal(choice.applies, false)
})

test('applyBindings 只在自己选后端时写环境变量', () => {
  const env = {}
  assert.equal(applyBindings({ applies: true, backend: 'dbus' }, env), true)
  assert.equal(env[BINDING_ENV], 'dbus')
})

test('applyBindings 不覆盖用户已有的显式值', () => {
  const env = { [BINDING_ENV]: 'hci' }
  assert.equal(applyBindings({ applies: true, backend: 'dbus' }, env), false)
  assert.equal(env[BINDING_ENV], 'hci')
})

test('applyBindings 对"不干预"的选择是无操作', () => {
  const env = {}
  assert.equal(applyBindings({ applies: false, backend: null }, env), false)
  assert.equal(env[BINDING_ENV], undefined)
})
