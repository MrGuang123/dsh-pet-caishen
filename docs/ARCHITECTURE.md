# 架构与目录

## 路线

当前本机 DSH 为 `0.2.1-rc.2`，桌面产品 API 没有提供通用 companion 窗口。因此采用插件加轻量 macOS 伴随程序，保留官方 DSH 安装，不修改 App 包、不依赖社区 Fork。

```text
dsh-pet-caishen/
├── lib/                    # DSH 宿主入口、客户端适配、状态归并、本机桥接
│   ├── client/             # 浏览器适配源码：constants/store/bridge/theme/fortune/merit
│   │   └── styles/         # DSH 内联客户端的 CSS 源文件
│   └── client.js           # 由 scripts/build-client.mjs 生成的单文件 ModuleLoader 入口
├── companion/
│   ├── macos/              # AppKit NSPanel + WKWebView
│   └── web/                # 共享角色、动效、交互与设置
├── assets/                 # 自制矢量角色／插件图标
├── locale/                 # 插件管理页文案
├── native/                 # 跟踪的双架构分发 App 与源码／文件摘要
├── scripts/                # 本地演示、原生构建、客户端打包、包检查
├── tests/                  # 状态、桥接边界、生命周期的行为测试
├── docs/                   # 产品、架构、开发、验收、素材说明
├── build/                  # 忽略的编译产物 Acai.app
├── output/                 # 忽略的截图和检查产物
├── package.json
└── cordis.patch.yml
```

DSH 的 `window.__ModuleLoader__` 只接收一个客户端 bundle，factory 内不能用本地 ESM import。`lib/client.js` 是由 `scripts/build-client.mjs` 把 `lib/client/**` 和 `lib/client/styles/**` 包装成无依赖 CommonJS 注册表后生成的入口；源码可读、入口保持单文件。

## 数据流

DSH 宿主通过 agent/status、agent/error、turn/end 及用户问题投影同步真实状态，不依赖前台页面定时器。客户端 sessionStatus store 仅补充待处理交互信息和处理导航。宿主归并最小状态，本机 loopback HTTP 服务提供只读快照与受限操作，原生窗口加载该服务的网页。

网页的“返回任务”只提交导航请求。宿主唤回 DSH，DSH 客户端通过真实 workspace navigation 服务处理请求并确认。请求有过期时间，不执行任意 URL、命令或模型调用。

## 接口边界

- DSH route：`/pet-caishen/bridge`。同源自定义 header，GET 查询桌面进程状态／导航请求，POST 提交待交互布尔补充、导航确认、启动请求或一次性动画请求。
- 功德金币：客户端在文档级监听主题 `.caishen-merit` 点击，POST `animate/coin`；宿主仅在宠物真实可见时把命令写入原生 stdin，原生转发给网页播放一次性动画。
- 财运开关：主题未声明 `__DSH_CAISHEN_STATUS_V1__` 时由客户端渲染。为避免与主题静态状态胶囊并排显示，客户端注入 `data-plugin-css="dsh-pet-caishen:fortune-status"` 的窄作用域样式；主题声明接管后立即移除，改由主题渲染唯一的开关。
- Companion HTTP：只绑定 `127.0.0.1`，随机端口、随机凭证。登录凭证只传给子进程，登录后换为 HttpOnly、SameSite=Strict cookie。
- `GET /api/state` 返回协议 v1 状态与偏好；`POST /api/preferences` 写入校验后的偏好；`POST /api/action` 仅允许求签、互动、导航。
- 修改请求必须携带 `X-Acai-Client: companion-v1` 和同源 Origin。浏览器演示额外开放 `/api/demo`，真实 DSH 模式拒绝模拟状态。
- 原生桥只接受固定的拖动、隐藏、hit zones 等消息，禁止网页发起任意外链或执行命令。

详细接口见 [PROTOCOL.md](PROTOCOL.md)。

## 生命周期与数据

启用插件时注册 DSH route 并启动本机桥接，自动启动已包含的 `native/Acai.app`；开发机器若有 `build/Acai.app` 则优先使用本地构建。缺少原生程序时显示重新安装提示，不静默退化为假桌宠。停用插件关闭服务和子进程；原生窗口同时监视父进程与 health。

本地偏好使用插件独立文件，写入通过临时文件加 rename 完成；不读取会话内容、推理文本、代码、凭据或成本。会话标题和状态只在内存中传递，不写入偏好文件。没有遥测或外部资源请求。

## 依据

- 本机 `DeepSeek Harness.app` 的 `0.2.1-rc.2` 已安装源码。
- [官方 Desktop product API](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/src/ipc.ts)。
- [社区 dsh-pet 桌面宿主限制](https://github.com/Luv061211/dsh-pet#readme)。

仅对实际检查过的 DSH 版本声明兼容；升级时重新核对 store、注入服务和导航契约。
