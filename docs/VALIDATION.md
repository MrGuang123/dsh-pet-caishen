# 验证记录

## 2026-11-13 · 顶部边界 AppKit 二次限制修复

复查发现上一节修复不完整：计算结果允许透明区域移出屏幕，但 `NSPanel.setFrameOrigin` 仍通过 AppKit 的 `constrainFrameRect` 将整个窗口限制在可用区域。独立原生对照中，请求 y=903 时普通面板实际停在 y=690，恰好被向下拉回 213 点；覆盖 `constrainFrameRect` 后实际 y=903。现在由已有的角色和控件范围计算负责约束，面板不再额外按整个透明窗口约束。首次点击修复仅更改鼠标接收和穿透轮询，并未修改垂直坐标或屏幕边界。

新增 AppKit 窗口回归：实际创建本项目的 `CompanionPanel`，对上下两边执行经过内容范围计算的 `setFrameOrigin`，验证最终窗口位置和 8 点内容边距；在本机通过。此检查验证窗口服务器的定位，不模拟真实鼠标拖动。`npm run check`、`npm test` 93/93、`check:native`、`check:package` 与 `check:install` 均通过；重新构建的双架构 App 在独立偏好域报告协议 5、可见和 rendererReady。用户随后确认日常使用中已可以拖到顶部；该确认仅覆盖此问题，多屏和完整插件安装流程仍需单独验收。

发布候选 `0.2.0-rc.5`：按新版本重新运行 `prepare:native`、`check`、`test` 93/93、`check:native`、`check:package`（66 个文件）和 `check:install`，均通过。原生程序包含 arm64／x86_64、最低 macOS 13、协议 5，签名为 ad-hoc；既有 rc.2 隔离运行与浏览器验收边界见下方历史记录。

从候选提交的干净源码打包后，用 DSH `0.2.2-rc.2` 自带 CLI 在独立 profile 离线安装，原生摘要及组合检查通过；以 `autoLaunch: false` 启动隔离 DSH web，桥接返回 200、原生程序可用。此验证使用 CLI 和隔离宿主，不等于插件管理页面、真实任务或完整日常安装验收。

`v0.2.0-rc.5` 标签工作流的 `npm test` 在 GitHub 托管 macOS 上失败，未生成 Release；GitHub 要求登录才能查看日志，具体失败测试未确认。`0.2.0-rc.6` 保留本机真实窗口定位验证，在 GitHub Actions 上明确跳过需要交互式 WindowServer 的测试，并让工作流在测试失败时标出失败的测试名。本机完整测试 93/93；模拟 GitHub Actions 环境时 92 通过、1 项实窗测试跳过。新版本双架构重建与包、安装和摘要检查通过；远端发布结果以 GitHub Release 为准。

## 2026-11-13 · 原生窗口顶部拖动边界

原因：原生窗口固定为 420×440 点，旧版垂直方向把整个窗口限制在屏幕可用区域内。角色在画布下方，顶部透明留白先触边，造成角色无法靠近屏幕顶部。此轮按角色、状态条和悬停按钮的实际四边范围夹住，屏幕边缘留 8 点；保存范围以便下次启动恢复。屏幕边界向网页回传上下范围，气泡、引导、设置和任务面板在边缘向内移动并限制高度。网页／原生协议升级为 5，旧原生程序会被拒绝。此轮遗漏了 AppKit 的二次整窗约束，见上一节后续修复。

| 验证层 | 本轮结果 |
| --- | --- |
| 离线测试 | `npm run check`、`npm test` 92/92 通过；Swift 几何覆盖上下限、透明留白、普通位置、上方副屏与小屏；网页测试覆盖四边范围和面板避边 |
| 浏览器预览 | 隔离 Chromium 模拟 420×440 原生视口及顶部可用区域，检查 120／160／240 尺寸的气泡、引导、设置和任务面板，12 组均落在可用区域；设置可滚动。属于合成布局，非真实桌面拖动 |
| 原生窗口 | 隔离 App 和偏好域启动成功，实际报告 protocol 5、可见及 rendererReady；尝试自动拖动时系统辅助接口返回 `AXError.notImplemented`，未取得真实拖动结果，仍需人工检查靠顶、触控及多屏 |
| 分发程序 | `prepare:native` 重建 macOS 13+ 双架构；`check:native`、`check:package`、`check:install` 通过，未发布 |
| 隔离真实 DSH／日常完整安装 | 本轮未执行；未修改日常 DSH 安装、profile 或主题 |

## 2026-11-12 · 首次点击拖拽修复

现象：阿财在其它应用前面时，第一次在宠物上按下不会开始拖动，必须先点一下面板，第二次才能拖动。核对安装版 WebKit：`WKWebView.acceptsFirstMouse` 只有在页面可开始拖拽或可旧式滚动时才返回 true；阿财的 `#pet` 声明了 `-webkit-user-drag:none`，页面也没有可滚动内容，默认返回 false。非激活 `NSPanel` 因而吞掉第一次 mouseDown，renderer 收不到启动拖拽所需的 pointerdown。

修复：`CompanionWebView` 覆盖 `acceptsFirstMouse` 返回 true，让非激活面板的第一次按下直接交给页面，不主动激活应用；可见期间以 10Hz 轮询真实光标位置更新 hit-zone 穿透，隐藏或睡眠时停止。原生消息、握手与拖动坐标算法未变。

| 验证层 | 实际结果与边界 |
| --- | --- |
| 源码契约 | 安装版 WebKit `WebViewImpl::acceptsFirstMouse` 在 `mightBeginDragWhileInactive`／`mightBeginScrollWhileInactive` 均为 false 时返回 false；阿财的 `#pet` 为非滚动页面上的普通按钮，且禁用 WebKit 拖拽 |
| Swift 回归 | `CompanionWebView.acceptsFirstMouse(for:)` 返回 true；同一 harness 中普通 `WKWebView` 返回 false。合成 `NSApp.sendEvent` 把 pointerdown 送入页面，面板保持非 key、应用保持非 active；该合成路径不模拟窗口服务器的首次点击消费，不能替代实机 |
| 离线测试 | `npm run check`、`npm test` 89/89（含首次点击回归）通过；10Hz 轮询仅在可见时运行，隐藏、睡眠或退出时停止 |
| 原生构建 | `npm run prepare:native` 重建 arm64 + x86_64、macOS 13 最低目标、ad-hoc 签名；Native 握手仍为 4，拖动协议不变 |
| 打包／安装 | `npm run check:package`、`npm run check:install` 通过；没有发布或修改日常安装 |
| 实机首击 | 已由用户完全退出并重开日常 DSH 后复验：第一次在宠物上按下即可直接拖动，无需先点一次；日常进程加载工作树构建的新 `build/Acai.app` |

## 2026-11-12 · 0.2.0-rc.4 发布检查

发布前在 macOS 27.0.1（arm64）执行 `npm run build:client`、`npm run prepare:native`、`npm run check`、`npm test` 89/89、`npm run check:native`、`npm run check:package`（65 个文件）与 `npm run check:install`，全部通过；原生 smoke 确认协议 4、渲染器就绪、显隐、金币动画和非法实例配置拒绝。Native 为 arm64 + x86_64、macOS 13+、ad-hoc 签名，`native/manifest.json` 与 Info.plist 均为 0.2.0-rc.4。

未覆盖：DSH 0.2.2-rc.2 的浏览器客户端工厂／界面未重新加载（无凭证）；真实任务、审批／提问、导航、Intel 实机、多屏／全屏 Space、连续拖动／穿透／快捷键、VoiceOver 和睡眠唤醒仍需验收。隔离 Host、原生 smoke 与首次点击人工复验不能替代这些实机项。

## 2026-11-12 · DSH 0.2.2-rc.2 兼容检查

安装版为 `0.2.2-rc.2`。现有 `engines.dsh` 范围允许该版本，但隔离启动发现插件未激活：新版 `AgentRegistry` 移除了 `roots()`，原适配器启动时抛出 TypeError。修复保留旧版 `roots()`；新版使用 `list()` 并按 session header 的 `origin: subagent` 排除子代理，带父会话的普通分支仍保留。新版不再提供旧版的运行时所有权关系，故这一判断采用其会话来源语义，不能声称两者完全等价。

| 验证层 | 实际结果与边界 |
| --- | --- |
| 源码与组合 | 只读核对安装版源码：新版 registry 提供 `list()`／`get()`，不再提供 `roots()`；会话列表以 `origin: subagent` 标识子代理。隔离组合树包含阿财，没有版本跳过 |
| 离线测试 | `npm run check` 通过；允许本机 loopback 后 `npm test` 88/88，含旧 registry 和新版子代理／分支聊天回归。沙箱内首次运行的 10 项监听测试因 EPERM 失败，不计为通过 |
| 隔离真实运行库 | 使用独立 profile、`autoLaunch: false` 和独立状态目录启动安装版 DSH web；修复前插件激活失败，修复后无激活失败告警，DSH 桥接 GET 返回 200 和可用桌面程序状态。未运行真实任务 |
| 浏览器加载 | 无凭证访问隔离首页返回 401；未读取登录凭证，未验证浏览器客户端工厂或界面加载。桥接 200 不代表浏览器验收通过 |
| 原生窗口 | 本轮未启动或操作原生窗口；既有原生握手和摘要检查通过 |
| 打包／安装 | `npm run check:package` 和 `npm run check:install` 通过；没有发布或修改日常安装 |
| 日常 DSH 完整安装 | 未执行；真实任务、审批／提问、导航和桌面物理交互仍需验收 |

## 2026-11-11 · 0.2.0-rc.3 DSH 0.2.2-rc.1 兼容修复

现象：DSH 从 `0.2.1-rc.5` 升级到 `0.2.2-rc.1` 后，插件页再次把 `dsh-pet-caishen` 标为「异常」。核对安装版 `app.asar`：`evaluatePluginCompatibility` 仍用 `semver.satisfies(runtime, engines.dsh, { includePrerelease: true })`；旧范围 `>=0.2.1-rc.5 <0.2.2-0` 的上界 `0.2.2-0` 低于预发布 `0.2.2-rc.1`，`loadProfileDirectory` 因而把整个 bundle 记入 `skippedBundles`。这不是 Host 服务或客户端插槽失效，而是版本范围写得太窄。

本轮改动与验证：

| 验证层 | 实际结果与边界 |
| --- | --- |
| 兼容判定 | `engines.dsh` 改为 `>=0.2.1-rc.5 <0.3.0-0`，覆盖整条 0.2.x；用安装版同款 semver 复核 `0.2.2-rc.1` 满足、旧范围不满足。`npm run check` 新增范围守卫，拒绝只覆盖单个 rc 的写法 |
| 源码契约核对 | 同时读取安装版 `0.2.2-rc.1` 与 npm `0.2.1-rc.5` 包：`agents`／`sessionProjections` 服务、`agent/status`／`agent/error`／`session/event` 事件、`title`／`userQuestions` 投影、审批／提问 waterfall 的 `next()` 透传、客户端 `sessions`／`uiSession`／`uiWorkspace`／`slots` 注入、`openSession`／`retainInfo`／`sessionStatus` 与会话插槽均保持同一契约；未改状态投影或桥接协议 |
| 组合检查 | 隔离 profile（`build/compat022`，仅 base／web-app／阿财）执行 `dsh --profile test --dump-config`：修复前明确输出 `skipping profile bundle "dsh-pet-caishen"`；修复后组合树包含 `pet-caishen` 且无跳过告警 |
| 隔离真实运行库 | DSH `0.2.2-rc.1` 隔离 profile 实际启动 `dsh web`（`autoLaunch: false`、临时 `stateDirectory`、端口 53991）：插件 Host `apply` 未报错；首页 boot graph 含 `dsh-pet-caishen` 客户端条目；`GET /pet-caishen/bridge` 以同源头返回 200 和预期桌面状态 |
| 浏览器加载 | 真实 Chromium 156（headless，独立 user-data-dir）加载同一页面：插件客户端工厂执行，`window.__DSH_ACAI_COMPANION_V1__` 存在，注入 `dsh-pet-caishen:fortune`／`fortune-status` 样式，首页显示「财运正在路上」，桥接轮询 `error` 为空；无未捕获异常、控制台错误或失败请求。证据：`output/compat-022/browser.json`、`browser.png`（忽略目录） |
| 自动检查 | `npm run check` 通过（客户端生成物一致、原生 0.2.0-rc.3 双架构摘要、42 个 JS 文件语法／宿主 import／身份／范围／locale）；`npm test` 87/87；`npm run check:package` 通过（64 个文件）；`npm run check:install` 通过干净打包安装、原生选择、`--check-config` 与签名校验 |
| 分发程序 | `npm run prepare:native` 重建 arm64 + x86_64、macOS 13 最低目标、ad-hoc 签名；`native/manifest.json` 与 Info.plist 均为 0.2.0-rc.3；Native 握手仍为 4、状态协议仍为 2 |

未覆盖：本轮没有重新打开原生窗口做人工交互，也没有在真实 DSH 插件管理页执行安装／启停，或运行真实任务。浏览器加载与隔离 web 启动不能替代原生窗口、完整 DSH 界面和日常安装验收。未修改已安装 DSH App、日常 profile 或同级财神主题；同级主题若仍声明旧范围，会被宿主单独跳过，需在其仓库另行放宽。

升级后需要完全退出并重新打开 DSH，宿主的组合与跳过结果才会重新计算；仅刷新浏览器页面不会重载被跳过的 bundle。

## 2026-11-03 · 0.2.0-rc.2 DSH 0.2.1-rc.5 兼容修复

现象：DSH 从 `0.2.1-rc.2` 升级到 `0.2.1-rc.5` 后，插件页的「已安装插件」把 `dsh-pet-caishen` 与 `dsh-theme-caishen` 都标为「异常」。核对安装版 `app.asar`：`evaluatePluginCompatibility` 使用 `semver.satisfies(runtime, engines.dsh, { includePrerelease: true })`；阿财的精确 `engines.dsh: 0.2.1-rc.2` 对 rc.5 不成立，`loadProfileDirectory` 因而把整个 bundle 记入 `skippedBundles`。财神主题 `0.2.2` 已把范围改为 `>=0.2.1-rc.5 <0.2.2-0`，同样配置下不再被跳过。

本轮改动与验证：

| 验证层 | 实际结果与边界 |
| --- | --- |
| 兼容判定 | `engines.dsh` 改为 `>=0.2.1-rc.5 <0.2.2-0`；用安装版 semver 复核 rc.5 满足、旧精确范围不满足 |
| 离线契约核对 | 从 rc.5 `app.asar` 读取源码，确认 `agents`、`sessionProjections` 服务，`agent/status`、`agent/error`、`session/event` 事件，`approval/request`、`user-questions/request` waterfall，`title`／`userQuestions` 投影，以及客户端 `sessions`、`uiSession`、`uiWorkspace`、`slots` 和两个会话插槽仍然存在；没有修改投影或桥接协议 |
| 组合检查 | 隔离 profile 执行 `dsh --profile test --dump-config`：修复前明确输出 `skipping profile bundle "dsh-pet-caishen"`，修复后组合树包含 `dsh-theme-caishen` 与 `dsh-pet-caishen` 两行，无跳过告警 |
| 隔离真实运行库 | DSH `0.2.1-rc.5` 隔离 profile 实际启动 `dsh web`（`autoLaunch: false`、临时 `stateDirectory`）：插件 Host `apply` 未报错，首页组合 bundle 返回 200 且同时含两个插件客户端模块，`GET /pet-caishen/bridge` 以同源头返回 200 与预期桌面状态 |
| 自动检查 | `npm run check` 通过：客户端生成物一致、原生 0.2.0-rc.2 双架构摘要、42 个 JS 文件语法／宿主 import／插件身份／locale；`npm test` 87/87 |
| 分发程序 | `npm run prepare:native` 重建 arm64 + x86_64、macOS 13 最低目标、ad-hoc 签名；`native/manifest.json` 与 Info.plist 均为 0.2.0-rc.2；`npm run check:package` 通过（64 个文件，851,090 字节），`npm run check:install` 通过干净打包安装、原生选择与签名校验 |

未覆盖：真实桌面窗口与完整 DSH 界面点击流程、真实任务端到端导航、Intel 实机、多屏／全屏 Space、连续拖动／穿透／快捷键、VoiceOver、睡眠唤醒。隔离 web 启动与 HTTP 200 不能替代这些实机验收；本次未修改已安装 DSH App、日常 profile 或财神主题。

升级后需要完全退出并重新打开 DSH，宿主的组合与跳过结果才会重新计算；仅刷新浏览器页面不会重载被跳过的 bundle。

## 2026-10-24 · 0.2.0-rc.1 预发布候选

气泡修复及本轮功能代码检查完成；整体 2D 阶段的实机验收仍有缺口，因此采用预发布版本，不将 S7／R16 标记为全部完成。本节仅记录已执行的发布前验证，远端发布结果以 GitHub Release 为准。

| 验证层 | 实际结果与边界 |
| --- | --- |
| 自动检查 | `npm run check`、`npm test` 87/87、`check:native`、`check:package`、`check:install` 通过；客户端生成物已同步 |
| 分发程序 | 0.2.0-rc.1、Native 4、arm64 + x86_64、macOS 13 最低目标；源码／完整 App SHA-256 与 ad-hoc 签名通过 |
| 真实运行库隔离 | 实际 Cordis 4.0.5／DSH scope 验证 observer 原值／原错误、完成身份、旧确认与卸载；实际插件临时目录、loopback、route 清理通过，无真实任务 |
| 实际插件管理器隔离 | DSH 0.2.1-rc.2 PluginManager + pnpm 11.28.5 离线安装候选 tgz、元信息／兼容、启停选择保存、实际 Cordis Loader 加载与桥接 GET 200、停用清理、pnpm 卸载通过；临时 profile／store／cache 已删除。未注入 HMR，管理器返回 restart-required，Loader 启停显式模拟重启边界；不是完整 DSH UI 验收 |
| 气泡布局 | 浏览器／实际 WKWebView 各 18 组 420×440 合成布局，120／160／240px、普通／大字、短句／带按钮多行／长文；短内容无溢出，长文可滚动，外层溢出为 0。复建原结构对照为 8px 假溢出 |
| 长消息重开 | 实际 WebKit 中隐藏时重置 scrollTop 会保留旧偏移；修复为先显现再重置，两端验证偏移归 0 |
| 原生启动与恢复 | 新分发程序实际 rendererReady、收起／唤回、一次性金币与非法配置检查通过。隔离页面主动 retry-renderer 重载后收到 1 次 acai-screen，修复未移动窗口时边界被去重的问题；不等于 WebKit 故障或睡眠唤醒验收 |

证据留在忽略的 `output/release-tests.log`、`output/release-manager-report.json`、`output/bubble-qa/browser.json`、`native.json` 与 `native-rc.png`。未修改日常 DSH profile、已安装 DSH App 或同级主题，没有读取真实任务正文或登录凭证。

完整 DSH UI／真实任务端到端、Intel 实机、多屏／全屏 Space、连续拖动／穿透／快捷键、VoiceOver、系统减少动态切换、睡眠唤醒和多实例物理交互继续保留待验收；3D 不在本版范围内。

## 2026-10-23 · 2D 增强工作树

状态：代码与协议已更新、自动检查及隔离冒烟完成；不是已发布版本，也不是所有实机验收已完成。目标仍为 DSH `0.2.1-rc.2`、macOS 13+。本机为 Apple Silicon。

| 验证层 | 本次结果 | 实际覆盖与限制 |
| --- | --- | --- |
| 离线行为测试 | 87/87 通过 | 轮次身份、先结束后停止、旧确认、等待补正、导航、偏好迁移／暂静时钟、诊断脱敏、锁定拖动、渲染确认及既有回归 |
| `npm run check` | 通过 | JS、宿主 import、客户端 bundle、locale、Native 协议 4 与源码／二进制摘要 |
| 真实运行库隔离 | 通过 | 只读提取已安装 DSH 的 Cordis 4.0.5 与 dsh-scope，使用虚构 root 验证 observer 原值／原错误透传、完成身份、防旧确认与卸载；实际 lib/index.js 用临时目录及 autoLaunch:false 验证 async apply、loopback 与 route 清理 |
| 浏览器预览 | 通过已检查场景 | 两任务列表／数量／标题／时长、收起一条完成提醒后保留另一运行任务、暂静倒计时、大字、迷你、最小诊断；420×440 内 120／160／240px、设置滚动和低动效开关；修复大字面板顶端溢出与迷你模式误把整窗当悬停区域 |
| 原生窗口 | 隔离冒烟通过 | 独立 bundle／偏好域，实际 protocol 4、rendererReady、visible，收起为 false 且进程仍在，重新唤回为 true，一次性金币指令、非法实例配置拒绝；有真实窗口截图 |
| 原生物理交互 | 未完成 | CUA 对本 NSPanel 的点击返回 AXError.notImplemented，未取得连续拖动、穿透与快捷键的真实输入结果；Swift 几何回归不替代本项 |
| 分发程序 | 通过 | prepare:native 重建 arm64 + x86_64、macOS 13 最低目标、ad-hoc 签名、Native 4、源码及完整 App 摘要 |
| 打包／干净安装 | 通过 | check:package、check:install：无 build/ 的包选择 native/ 程序、配置与签名校验；无首次下载、无安装脚本，没有发布 |
| 真实 DSH 完整安装 | 未执行 | 未在日常 profile 安装或刷新，也未操作真实任务；实际插件管理器安装、并发／审批／问题／结果／返回流程仍需隔离实机验收 |

新增字段与边界见 [STATE_CONTRACT.md](STATE_CONTRACT.md)、[PROTOCOL.md](PROTOCOL.md)。当前实现包含 R01–R15 的增量；R16 及专项验收不能只按源码关闭。快捷键可配置 A–Z 或停用，修饰键固定 ⌃⌥⌘。多 profile 共用默认目录时不自动辨认归属，需要不同 instanceId 或独立 stateDirectory。

### 需求证据索引

| 需求 | 现有证据 | 未关闭边界 |
| --- | --- | --- |
| R01 | fixedTarget／旧气泡 409 自动测试；浏览器标题列表 | 真实 DSH 气泡导航 |
| R02 | 重复 end、跨轮确认、已呈现标记自动测试；浏览器单条提醒收起 | 真实 DSH 选中流程 |
| R03 | 浏览器 waiting 时摸头后状态入口仍保留；拖动／锁定回归 | 原生实际鼠标输入 |
| R04 | 浏览器两任务列表／数量及收起后剩余活动 | 真实并发任务 |
| R05 | 迁移、到期、重启、时钟变化自动测试；浏览器剩余分钟 | 长期使用 |
| R06 | 420×440 浏览器空闲迷你收起、waiting 重新露出入口 | 原生悬停／穿透 |
| R07 | 真实库事件、未知起点／结束自动案例；浏览器时长 | 真实任务实机 |
| R08 | 本地签库不连续重复测试、三种短动作实现 | 动作长期体验 |
| R09 | SVG 表情与节奏实现、浏览器／原生截图 | 长期观看与所有壁纸 |
| R10 | 浏览器 120／160／240px、大字、设置滚动、AX 名称 | VoiceOver 与原生输入 |
| R11 | 浏览器手动低动效开关、系统媒体查询及金币规则 | 实机系统偏好切换 |
| R12 | 固定锚点／几何／锁定测试；Native 快捷键结果、配置检查；本应用旧窗口坐标迁移 | 多屏／真实快捷键／多实例交互 |
| R13 | 隔离原生三场景短采样、隐藏停止无用刷新实现 | 能耗／GPU／帧时间／拖动 |
| R14 | 渲染未就绪不算成功的自动测试、真实 Native 就绪与收起唤回 | WebKit 故障注入／睡眠唤醒 |
| R15 | 敏感哨兵诊断脱敏测试、浏览器预览、实际原生 App 版本上报 | 原生剪贴板兼容；不可用时有手动复制回退 |
| R16 | check／test／打包／干净安装／真实库隔离 | 上述专项与完整 DSH 安装、Intel |

### 性能短采样

开发脚本 `scripts/baseline.mjs` 仅复制本项目 App，更换 bundle ID 和独立偏好域，用内存虚构任务采样。源码基线保存在忽略的 output/s0-baseline/source；报告均在 output/baseline-*/report.json。每场景预热后 8 次约一秒间隔采样。

| 场景 | 优化前 ps CPU 均值／RSS MiB | 增强版 ps CPU 均值／RSS MiB |
| --- | --- | --- |
| 空闲 | 8.33／132.43 | 3.50／125.22 |
| 运行 | 8.19／131.23 | 3.11／127.62 |
| 隐藏 | 0.48／131.54 | 0.13／123.80 |

这些是参考观测值，不是严格性能提升结论：ps CPU 为衰减估计、RSS 相加可能含共享页，部分 WebKit XPC 无法归因，采样时间短且背景负载不同；采集脚本的子进程过滤也有修正。没有测到 GPU、实际能耗、帧时间、唤醒频率和真实拖动性能，报告相应值为 null／未测，不据此承诺耗电下降比例。

### 本阶段尚未关闭的实机项目

- 完整 DSH 插件管理器安装／启停、真实并发任务、审批与提问、完成／错误／停止、直接选中和返回导航。
- 连续拖动、透明区穿透、不抢焦点、左右停靠与位置重置、快捷键实际响应和冲突、多屏接拔／负坐标副屏／全屏 Space。
- 系统减少动态切换、VoiceOver、复杂壁纸，以及睡眠唤醒和 WebKit 内容进程故障恢复的实际输入／故障注入。
- 多 profile 的独立配置及物理交互，Intel 实机；未测平台不声称通过。3D 继续后置。

本次未修改已安装 DSH App、日常 profile 或同级财神主题；仅清理本次独立验证进程。过程截图和数据均留在忽略的 output/。

### 短气泡滚动条修复

- 原因：气泡底部外置的 `:after` 尖角被纳入整块气泡的 `overflow-y:auto` 滚动范围，短句也产生约 8px 虚假溢出，裁切后的尖角只剩看似「∨」的边框。移除尖角并统一圆角，滚动范围改为内部 `.speech-content`，内容超过可用高度才滚动。每次换消息归零滚动位置，帮助使用同样结构并保留键盘聚焦。
- 使用合成内容及独立 bundle／偏好域，在真实原生 WKWebView 和浏览器的 420×440 布局分别检查 18 组：120／160／240px × 普通／大字 × 短句／带按钮多行／长文。已检查短句和多行内部溢出均为 0，长文均能设置有效滚动位置，气泡位于窗口内；原结构对照短句仍出现 8px 溢出。
- 报告在忽略的 `output/bubble-qa/browser.json`、`native.json`，原生短句截图为 `native-short.png`。这是隔离合成布局验证，未在日常 DSH 上替换或刷新插件，也未替代真实滚轮／键盘输入验收。本次只改网页资源，不涉及 Swift 源码或原生二进制重建。

## 2026-10-19 · 首版历史记录

验证日期：2026-10-19。版本：0.1.0。机器：macOS、Apple Silicon；DSH 目标 `0.2.1-rc.2`。

## 自动检查

| 项目 | 结果 | 说明 |
| --- | --- | --- |
| `npm run check` | 通过 | 先校验客户端 bundle 最新，再检查 JS 语法、宿主 imports、ModuleLoader 身份、语言键 |
| `npm run build:client` | 通过 | 从 `lib/client/**` 与 `lib/client/styles/**` 生成单文件 `lib/client.js`；无第三方依赖 |
| `npm test` | 58/58 通过 | 状态优先级、结束原因、waterfall透传、导航确认、卸载、认证、跨源/Host/畸形URL/请求体限制、偏好原子写入、财运开关、原生协议握手、金币动画、实际拖动范围、面板避边、上次选中聊天、固定鼠标锚点、手势结束及无 build 目录时的原生入口 |
| `npm run build:macos`、`npm run prepare:native` | 通过 | Swift arm64 + x86_64 通用程序，最低 macOS 13 |
| `codesign --verify --strict --all-architectures native/Acai.app` | 通过 | 两个架构均为 ad-hoc 签名，未做 Developer ID 公证 |
| `npm run check:native` | 通过 | 检查版本、协议 3、Mach-O 双架构格式、可执行权限、源码和整个分发 App 的 SHA-256 |
| 原生配置检查 | 通过 | 合法配置、错误主机/协议/端口、跨源配置等 9 项；不打印登录凭证 |
| `npm run check:package` | 通过 | dry-run 包含运行源码、构建源码、SVG 和 native/ 分发 App，无 build/、output/ 或用户配置 |
| `npm run check:install` | 通过 | 实际打包并解压到临时目录；无 build/ 时正确选择预编译入口，宿主 import、源码／二进制摘要、原生配置检查和签名校验通过 |
| 英文命名与启动入口 | 通过 | 统一为 Acai／acai；原生应用与可执行文件已重建，旧生成物已清理，启动配置与签名检查通过 |

HTTP 测试需要本机 loopback 监听权限。sandbox 的 EPERM 不是测试通过；已在允许本机监听后执行并通过。打包检查使用临时 npm cache，不修改用户的 npm 目录。

## 真实 DSH 运行库的隔离验证

使用已安装 App 中的源码，未修改 DSH App 或日常 profile：

- **Cordis 4.0.5 + dsh-scope**：验证 async apply、effect 中注册事件、真实作用域 waterfall 的 `(request,next)`、结束事件与卸载监听清理，fiber 成功 Loaded。
- **项目实际 lib/index.js**：使用临时偏好目录、`autoLaunch:false` 和真实 Cordis；本机桥接启动、route GET契约与卸载删除 route 通过。
- **真实 ClientModuleRegistry**：本项目与四项已安装客户端依赖成功组成 graph，immediately/inject正确，bundleResource返回200且ModuleLoader id一致。
- **SlotRegistry 与 Desktop 代理源码**：核对 list session slots 注册契约，以及自定义 header 在桌面代理中的保留。

这类检查确认库契约与生命周期，不等于日常插件管理器界面和真实任务验收。

## 0.1.0 分发安装检查

- 在临时目录使用 DSH 随附的 pnpm 11.28.5，离线安装实际 `.tgz`，禁用安装脚本，使用独立 store／cache；没有运行依赖和首次启动下载。
- 用真实 DSH 的 `evaluatePluginCompatibility` 确认 `0.2.1-rc.2` 兼容检查通过；真实 `readPluginMeta` 解析中文标题、描述与 SVG 图标成功（展示字段使用 `locale.meta`）；bundle patch 通过真实 `composeEntries` 得到宿主插件行。
- 对安装后的文件运行真实 Cordis 与 ClientModuleRegistry：宿主加载、桥接 GET、预编译程序可用状态、客户端资源 HTTP 200，以及停用后的 route 清理均通过。使用临时偏好目录和 `autoLaunch:false`，未修改已安装 App 或日常 profile，也未启动多余桌宠。
- GitHub 标签工作流会重复语法、测试、分发文件摘要、签名与干净安装检查，再发布 `.tgz` 与 `SHA256SUMS`；远端安装结果以实际完成的发布记录为准。

## 界面与原生窗口

### 本次持续拖动漂移修正

- 原因：网页 `screenX/screenY` 位移经过异步桥接，不断加到原生窗口的当前位置；移动中的 WebView 又会影响后续指针事件，形成位移反馈。坐标与窗口位移不应由两端分别累加。
- 修正：原生以按下时的全局鼠标坐标与窗口原点为固定锚点，60Hz 读取 `NSEvent.mouseLocation`，直接计算期望位置；不再接收网页位移。common-mode 定时器独立检测松手，丢失网页 pointerup 或 capture 时也能结束；取消、收起与屏幕配置变化也会清理手势。
- 新增 7 项回归：实际 Swift 函数连续 10,000 次读取同一鼠标位置不漂移，检查坐标方向、负坐标屏幕、夹边后回到原锚点和多次手势；网页测试覆盖合成位移不累加、原生松手兜底、取消、点击与拖动区分、过期手势事件及预览拖动。HTTP 测试确认新增拖动模块可通过已认证入口加载。
- 原生握手更新为 3；旧协议 2 的程序会被拒绝，防止新网页与旧拖动实现混用。本次已完成 Swift 构建、签名、打包检查，并由真实宿主控制器启动临时原生演示，协议 3 与可见性确认成功；随后停止演示，确认剩余宠物进程属于日常 DSH，未终止它。
- 原生拖拽自动化被窗口接口 `AXError.notImplemented` 阻挡，未取得实窗连续拖动验证结果。上述坐标和事件回归测试不等于日常 DSH 实机拖动验收，需完全退出并重启 DSH 加载新程序后复验。

### 左右边界与返回聊天修正

- 原因：原生窗口以前按完整 420px 宽度夹取位置，角色旁的透明留白会提前碰到屏幕边界。
- 修正：网页上报角色、状态条和悬停工具栏的实际左右范围；原生按该范围保留 8px 屏幕边距，允许透明留白越过屏幕边缘。设置和气泡根据可见区域向内排布，纵向约束保持原样。
- 使用实际 Swift 几何函数执行回归检查：1440px 主屏左右边缘、负坐标副屏及中间位置通过；工具栏仍保留在屏幕内。
- 新增悬停工具栏返回箭头。DSH 当前绑定订阅独立记忆上次选中聊天；宿主只保存会话 ID，不依赖任务优先级或存活 root，因此返回阅读中的历史聊天不会误选后台任务。选中订阅、卸载清理、HTTP 返回目标与非法标识检查通过。
- 此次边界修正曾将原生握手更新为 2；当前持续拖动修正已升级到 3。日常 DSH 中的拖动手感与历史会话返回仍需重启后实机复验。

### 既有版本的界面验收记录

- 浏览器实际检查 420×440，角色大小 120／160／240、设置滚动、业务状态与道具、摸头、睡觉、求签、安静模式、减少动画。
- 浏览器控制台无报错；离线演示已实际切换，界面明确显示“等待 DSH 连接”。
- 已修复原生提示文字与状态胶囊重叠，以及演示控件覆盖设置的问题。
- 已通过原生程序真实启动，WKWebView cookie 登录、角色显示和设置面板可见；设置中“收起阿财”能收起窗口。
- 原生收起后，向已核实的本项目进程发送 SIGUSR1，窗口重新可见；DSH 按钮采用这一幂等唤回途径。全局快捷键已实现，自动化按键检查未能确证，仍需人工验证冲突与实际响应。
- 财运开关的客户端离线测试已覆盖：主题未声明 `__DSH_CAISHEN_STATUS_V1__` 时隐藏主题静态状态胶囊，主题接管后恢复；收起显示灰色“财运正在路上”，唤回恢复“今日财运在线”。真实 DSH 页面中的视觉位置仍需人工复验。
- 用真实功德图重建头部行核对：标准模式 22px 保持宿主居中；模型选择/菜单/财运开关均为 30px，顶部坐标一致；“功德 +1”容器单独 `position:relative; top:6px`，图片顶部与 30px 控件对齐且不改变行布局。浏览器演示实际触发金币动画并截图，金币从手边升起、不遮脸。原生 `desktop.animate("coin")` 在真实二进制上返回 true；真实 DSH 页面需重载插件并刷新页面后人工复验。
- 角色 SVG 已用 Chrome 离屏渲染核对：眉毛加长，鬓角改为贴着耳朵前缘、上宽下窄的楔形，向下收尖且不向脸颊勾，与眉毛分开；running 状态仍显示算盘和墨镜。
- 使用重建后的真实 `build/Acai.app` 做了隔离冒烟：收到 `hello` protocol 1，启动后 `visible:true`，收起后 `visible:false` 且窗口离屏，再唤回后恢复 `visible:true`。旧二进制缺少握手时会在超时后终止并提示重新构建；此前正是未重建的旧二进制导致窗口已显示、开关却停留在“财运正在路上”。
- 结束原生演示后，已检查无残留宠物进程；浏览器演示服务也已停止。

角色演示图位于 `docs/screenshots/acai-preview.png`，由当前 `assets/acai.svg` 与网页样式在 420×440 视口直接截取，展示空闲状态的大眼睛、长眉毛与修整后的鬓角；已替换早期小眼睛版本的 JPEG。过程截图位于忽略的 `output/`。

## 仍需人工验收

1. 在日常 DSH 的插件管理器完成安装、启用、真实任务运行、审批、结束、报错、返回对应会话，以及首页与会话工具栏财运开关的实际位置和收起／唤回检查。
2. 多屏接拔、不同分辨率、全屏 Space、系统 reduced motion、透明区域点击穿透、原生拖拽与全局快捷键冲突。
3. DSH 完全退出／插件卸载后的完整进程清理，以及多 profile 同时运行时的交互体验。

本次开发没有修改用户的财神主题、日常 profile 或已安装 DSH App。未验证平台不声明正式支持。

## 已知边界

- 原生产物包含 arm64 与 x86_64；本机原生运行记录来自 Apple Silicon，Intel 尚未进行实机交互验收。Windows／Linux 原生宿主未提供。
- 插件在已有审批进行中被重新加载时，过去的 waterfall 无法由宿主观察器回放；已加载客户端的真实 pending 快照会补正，补充事实在 8 秒失联后过期。后续新审批由宿主直接观察，不依赖前台定时器。
- 当前宿主仅追踪存活的 root Agent，未加载的历史会话不是任务历史中心。
- 原生窗口遵守系统安全界面、锁屏与独占全屏规则。
- “本轮结束”仅表示 DSH 的 completed 结束原因，不保证测试通过或工作结果正确。
