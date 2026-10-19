# 开发与打包

## 工具与命令

Node.js 22+；macOS 原生构建使用 `xcrun swiftc`、AppKit、WebKit、Carbon 与 `codesign`。无 npm 安装脚本、运行依赖或远程字体。

```bash
npm run build:client
npm run check
npm test
npm run build:macos
npm run prepare:native
npm run check:package
npm run check:install
```

测试会在 `127.0.0.1` 的随机端口创建短生命周期服务，需要允许本机监听。偏好测试使用临时目录，不读写日常 DSH profile。原生构建产物和 module cache 仅放在 `build/`。

`npm run dev` 是网页演示，`npm run start:macos` 是原生演示。两者都清楚标注演示状态，无法导航到真实任务；结束开发服务器用 Ctrl+C。

## 客户端源码结构

DSH 的 `window.__ModuleLoader__` 只加载一个 `./client` 资源，factory 里没有本地 ESM import。因此浏览器适配源码拆在 `lib/client/`，由无依赖的 [build-client.mjs](../scripts/build-client.mjs) 包装成一个供 DSH 加载的 `lib/client.js`：

```text
lib/client/
├── index.js       # 组合 store / bridge / theme / control，注册 effects 和 slots
├── constants.js   # bridge 端点、事件名、样式 id
├── store.js       # 小型 observable snapshot
├── bridge.js      # 轮询、pending 补充、导航确认、toggle、animate
├── theme.js       # provider、主题事件、静态胶囊隐藏样式的注入/移除
├── fortune.js     # 财运开关 React 组件
├── merit.js       # 功德 +1 点击 → 金币动画
└── styles/
    ├── fortune.css       # 开关外观
    └── theme-status.css  # 主题静态胶囊隐藏
```

`lib/client.js` 是生成物，不要直接编辑。修改 `lib/client/**` 或 `lib/client/styles/**` 后运行 `npm run build:client`；`npm run check` 会先校验生成物是否最新，`npm test` 会在测试前重建。

## 修改入口

| 修改 | 文件 |
| --- | --- |
| 人物和道具 | `assets/acai.svg`、`companion/web/character.js` |
| 动作、气泡、设置 | `companion/web/styles.css`、`app.js` |
| 原生窗口、鼠标穿透、全局快捷键 | `companion/macos/main.swift` |
| 宿主任务投影 | `lib/dsh-adapter.js` |
| DSH 页面客户端 | `lib/client/*.js`、`lib/client/styles/*.css`；生成入口 `lib/client.js` |
| 本机服务、认证与偏好 | `lib/bridge-server.js`、`preferences.js` |
| 启停和进程清理 | `lib/index.js`、`desktop.js` |

## DSH 契约

当前实际核对版本 `0.2.1-rc.2`，本机 desktop build commit 为 `332895e0f7c9d4dbfb29729f5eb367fa263ff986`。客户端不是另一份 React bundle，而是使用宿主 `window.__ModuleLoader__` 和宿主 React。

服务：`agents`、`sessionProjections`；状态事件：`agent/status`、`agent/error`、`session/event`。投影只读 `title` 和 `userQuestions`。审批与问题 waterfall observer 始终将 `next()` 原值／错误透明传回，绝不回答、批准或改写任务。

客户端注入 `sessions`、`uiSession`、`uiWorkspace`、`slots`。导航为 `ctx.uiWorkspace.openSession(id)`；前端使用 `sessionStatus` 补充已存在的 pending interaction，补充事实有独立过期时间，不决定宿主连接状态。

修改适配器时，不以 DOM class、页面文字或浏览器内外观来推测任务状态。DSH 升级后重新检查这些契约，不直接扩大 engines 范围。

## 分发

`npm run check:package` 生成 npm 的 dry-run 清单，不发布；`check:install` 实际打包到临时目录再解压，检查无本机 `build/` 时仍能使用预编译程序。正常安装选用 `native/Acai.app`；开发机器存在 `build/Acai.app` 时优先使用本地构建。

对外分发前运行 `npm run prepare:native`，编译 arm64 + x86_64 通用程序，执行 ad-hoc 签名，复制分发 App 到 `native/` 并记录源码和二进制摘要。`native/` 是为 GitHub 安装跟踪的分发产物，编译缓存仍在忽略的 `build/`。标签触发 GitHub Release，详细步骤见 [RELEASING.md](RELEASING.md)。Developer ID 公证未提供，Intel 仍需实机验收。

不提交 `build/`、`output/`、本机登录凭证或偏好文件。无需修改已安装的 DSH 应用包，也不要复制用户账户、profile 或会话配置到本仓库。
