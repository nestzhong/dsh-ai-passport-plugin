# Linux 与树莓派（宿主侧安装）

本文记录在 Linux 主机（重点是树莓派）上跑 DSH + 本插件的完整过程，以及
BLE 后端选择这个**唯一但致命**的坑。桌面端（macOS / Windows）见
[04-桌面客户端集成](04-桌面客户端集成.md) 与 [08-Windows反馈清单](08-Windows反馈清单.md)。

## 1. 适用形态

Linux 上 DSH 以 `dsh web` 运行，插件装在 **web profile**。设备（AI Passport）
仍然是通过 BLE 直连这台机器，和桌面端是同一套链路：

```
AI Passport（ESP32-C3）  <-- BLE GATT -->  树莓派：dsh web + 本插件
                                              ↑ 浏览器访问 127.0.0.1:3080/dsh-passport
```

## 2. 实测环境（2026-10-29）

| 项 | 值 |
| --- | --- |
| 硬件 | Raspberry Pi 5 / aarch64 |
| 系统 | Debian GNU/Linux 13 (trixie)，内核 6.18 |
| 蓝牙 | BlueZ 5.82（`bluetooth` 服务 active），适配器正常 |
| Node | v22.23.2（nvm 安装） |
| DSH | 0.2.1-rc.2（`dsh web`） |
| 插件 | 本仓库 1.2.0 |

结论：**可用**。插件加载、控制面板、Web 客户端挂件、语音 provider 识别、
BLE 扫描均已实测通过。

## 3. 安装步骤

```bash
# 1) 代码与依赖
git clone https://github.com/slinxiaosun-blip/dsh-ai-passport-plugin.git
cd dsh-ai-passport-plugin
npm install                     # @stoprocent/noble 与 dbus-next 都会装上

# 2) 装进 web profile（符号链接 + bundles 登记）
npm run install-plugin -- web

# 3) 启动（前台跑一次看日志，确认没报错再考虑后台）
NOBLE_BINDINGS=dbus dsh web --host 127.0.0.1 --port 3080
```

要点：

- `dbus-next` 是**可选依赖**，`npm install` 会一起装。它不在 profile 层出现也没关系——
  桥进程按插件源码的真实路径向上找 `node_modules`，仓库根的那份就够。
- `dsh plugin --profile web add ...` 也能装，但它会**拷贝**一份到 profile 的
  `node_modules`，改源码不生效。开发用本仓库的安装脚本（符号链接）。
- 首次安装/首次登记 `dsh.profile.bundles` 后**必须重启 DSH**（bundles 只在启动时读）。

## 4. BLE 后端：为什么 Linux 上要特别处理

noble 在 Linux 有两个互斥后端（`@stoprocent/noble` 的 `lib/resolve-bindings.js`）：

| 后端 | 走什么 | 权限 | 我们实测到的现象 |
| --- | --- | --- | --- |
| `dbus` | BlueZ 的 `org.bluez` D-Bus 接口 | 普通用户即可 | 正常扫描，**能拿到设备名**（localName） |
| `hci` | raw HCI socket（`/dev` + ioctl） | root 或 `CAP_NET_RAW` | 普通用户下状态停在 `unknown`，`startScanning()` **不报错也不扫描** |

危险的地方在于 `hci` 的失败方式**是静默的**：面板点「扫描并连接」后链路进入
`scanning`、桥进程也活着，但设备列表永远是空的。用户只会觉得"蓝牙坏了"。

所以插件现在在桥进程里**自动选后端**（`lib/ble/bindings-choice.js`）：

1. 用户显式设了 `NOBLE_BINDINGS` → 完全听用户的（`hci` / `dbus` / …）；
2. 否则在 Linux 上、且能解析到 `dbus-next` → 自动设 `NOBLE_BINDINGS=dbus`
   （必须在 `import noble` 之前设置，noble 在模块加载时读这个变量）；
3. 否则不干预，交给 noble 按平台选（macOS / Windows 不受影响）。

同时补了兜底：后端加载完但适配器最终没进 `poweredOn` 时，明确抛错并给出
Linux 专属提示，而不是让上层一直转圈。

诊断字段里新增 `bindings`（实际用的后端），面板底部显示为「后端 dbus」。

### 仍然想用 hci 后端

```bash
sudo setcap cap_net_raw+eip "$(which node)"
NOBLE_BINDINGS=hci dsh web --host 127.0.0.1
```

注意两点：

- **nvm 升级 Node 后 setcap 会丢**（能力挂在具体二进制文件上），升级后要重设；
- 给 `node` 加 `cap_net_raw` 意味着这台机器上**任何** Node 脚本都能开 raw socket，
  安全面比 D-Bus 后端大。能用 `dbus` 就别用 `hci`。

## 5. 面板访问

默认 `--host 127.0.0.1`：面板只在本机可达。

- 在树莓派本机：`http://127.0.0.1:3080/dsh-passport`
- 从别的电脑：`ssh -L 3080:127.0.0.1:3080 pi@<host>`
- DSH 首页本身要 token（启动日志里那串 `?token=...`），**面板 `/dsh-passport` 不需要**，
  但它会读 DSH 的服务，所以仍然建议只绑回环、别暴露到公网。

## 6. 开机自启（可选）

本插件不需要常驻进程，跟着 `dsh web` 走即可。用 systemd 用户服务时记得
把环境变量一起带上，否则会退回 `hci` 后端：

```ini
# ~/.config/systemd/user/dsh-web.service
[Unit]
Description=DeepSeek Harness (web)

[Service]
WorkingDirectory=%h
Environment=NOBLE_BINDINGS=dbus
ExecStart=%h/.nvm/versions/node/v22.23.2/bin/dsh web --host 127.0.0.1
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now dsh-web
loginctl enable-linger "$USER"     # 没登录也要跑时
```

> 环境变量只写在 `~/.bashrc` 里**只对交互式 shell 生效**。用桌面图标、systemd、
> cron 拉起时必须在该入口自己带上 `NOBLE_BINDINGS=dbus`。

## 7. 排障对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 面板打得开，点扫描一直 `scanning`、设备列表空 | 用了 `hci` 后端但没有权限 | `npm install dbus-next`；确认没显式设 `NOBLE_BINDINGS=hci` |
| 诊断里 `后端 hci` | 环境里没有 `dbus-next`，或显式指定了 | 装 `dbus-next`，去掉显式变量 |
| `适配器 unauthorized / poweredOff` | BlueZ 侧适配器被关或被 rfkill 挡住 | `rfkill list bluetooth`、`bluetoothctl power on` |
| 面板 404 | 插件没被加载 | 看 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 有没有 `dsh-ai-passport`；改完要重启 |
| 挂件语音区提示「ctx.speechToText 不存在」 | 语音子系统没挂 | 见 README「快速开始」里的 speech-to-text insert 两条 |
| `EADDRINUSE 3080` | 端口被占用（profile 里配了固定端口） | 改 `profiles/web/cordis.patch.yml` 的 `webserver.port` |
| 桥进程日志 `noble 实现：@stoprocent/noble` 但没设备 | 设备没上电 / 不在范围内 / 已被别的机器连着 | 设备上电后重试；BLE 同一时间只能被一台主机连 |

## 8. 已验证 / 未验证

已验证（树莓派 5 实测，2026-10-29）：

- `npm install` 不需要编译原生模块——`@stoprocent/noble` 与
  `@stoprocent/bluetooth-hci-socket` 都有 `linux-arm64` 预编译产物；
- 安装脚本在 Linux 上走符号链接 + bundles 登记，成功；
- `dsh web` 启动后插件 `apply` 成功、面板 200、注入行出现在首页、
  `dsh-ai-passport/client.js` 出现在 Web 模块清单里；
- 语音 provider 识别为 `sensevoice-local` 且 `ready=true`；
- **BLE 全链路**：不设任何环境变量，桥进程自动选中 `dbus`，扫到真机
  `FoloPassport-DSH`（`98:C3:77:F6:B8:12`）、GATT 连接成功、协议 v1 握手完成
  （`handshakeComplete=true`）、MTU 244、`pairing.paired=true`，
  并读回设备信息：固件 `1.2.1+gv1.2.1-dsh-passport`、协议 1、电量 84%；
  上下行计数正常（`gaps=0 / bytesDropped=0 / ackTimeouts=0`）。

未验证：

- 设备端主动触发的两段：审批瀑布（`approval/request`）与语音回填；
- 长时间连接的稳定性（只跑了分钟级）；
- 多主机竞争（BLE 同一时间只能被一台主机连）时的重连行为。
