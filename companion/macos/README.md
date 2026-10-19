# 阿财 macOS 伴随程序

使用 macOS 13+ 自带 AppKit、WebKit 与 Carbon；源码编译需要 Xcode Command Line Tools，不依赖 Electron 或 npm 运行库。`node scripts/build-macos.mjs` 生成当前 CPU 架构的 `build/Acai.app` 并执行 ad-hoc 签名及校验；`--universal` 编译 arm64、x86_64 并合并。GitHub 安装已包含 `native/Acai.app`，用户无需编译。构建缓存只写入 `build/.module-cache`。本脚本不安装或启动应用。

宿主通过 stdin 写入一行 JSON 后启动应用的 `Contents/MacOS/Acai`：

```json
{"launchURL":"http://127.0.0.1:54321/launch?token=SECRET","baseURL":"http://127.0.0.1:54321/","parentPID":12345}
```

实际启动应通过 stdin 传令牌。开发时也支持 `--url http://127.0.0.1:54321/ --parent-pid 12345`。`--check-config` 只校验配置并退出，可用于无 UI 的协议检查。URL 只接受 HTTP、精确主机 `127.0.0.1`、1024–65535 端口及同一 origin，不接受凭据、fragment、任意外部导航或弹窗。启动信息和错误日志不会输出 URL 或令牌。WKWebView 使用临时 cookie 存储，认证由 `/launch` 设置 cookie 并重定向完成。

透明 NSPanel 的固定视口为 **420 × 440 CSS 像素**。窗口跨应用悬浮、出现在各 Space 中，显示时不主动激活其它应用。主页面注入 `window.__ACAI_NATIVE__ = true`，通过 `window.webkit.messageHandlers.acai.postMessage(...)` 发送：

| 消息 | 行为 |
| --- | --- |
| `{type:'ready'}` | 页面就绪 |
| `{type:'drag-start',id}` | 记录全局鼠标与窗口原点，开始原生跟随 |
| `{type:'drag-end',id,cancelled}` | 结束或取消对应手势 |
| `{type:'drag-bounds',left,right}` | 左右拖动按宠物／状态／悬停按钮占用范围约束，透明窗口留白不算边界 |
| `{type:'resize',size:120..240}` | 页面内部缩放，保留固定视口 |
| `{type:'hit-zones',zones:[{x,y,width,height}]}` | 交互热区，原点在视口左上角；热区之外点击穿透 |
| `{type:'hide'}` | 收起窗口，菜单栏保留 |
| `{type:'open-dsh'}` | 激活本机 `com.deepseek.dsh` 应用 |
| `{type:'quit'}` | 仅退出阿财 |

鼠标位置和按键每秒检查 60 次，无需辅助功能权限；网页位移不参与原生拖动计算，松手不依赖网页事件。握手协议为 3，完整消息与事件见 [PROTOCOL.md](../../docs/PROTOCOL.md)。拖拽位置保存在 UserDefaults，窗口移动与显示器变化后限制在可用屏幕区域内。菜单栏「财」可唤回、收起、打开 DSH、退出；全局 `Control + Option + Command + A` 切换显示，快捷键冲突时仍可用菜单栏。程序默认无声。

宿主可向已运行的伴随进程发送 `SIGUSR1`（Node 中 `child.kill('SIGUSR1')`）来**显示 / 唤回**窗口，发送 `SIGUSR2` 来**收起**窗口；两者均幂等，不会主动激活应用。程序在 bootstrap 阶段忽略两个信号的默认退出行为，再通过主线程 `DispatchSourceSignal` 接收；退出时取消并释放信号 source。

原生窗口实际显示或收起后，向 stdout 写出一行 JSON：`{"type":"visibility","visible":true}` 或 `{"type":"visibility","visible":false}`，并立即 flush；首次显示也回报。菜单栏、全局快捷键、网页消息和宿主信号共用同一显示 / 收起路径，重复操作不重复回报。该通道仅含状态，不含 URL 或令牌。宿主独立记录进程存活与窗口可见性；握手前、退出后均视为不可见，控制命令最多等待 3 秒确认，超时报告错误，不提前假定成功。

页面通过 `/launch` 的同源 303 重定向登录；renderer 内同源 `fetch` POST 由 WKWebView 自动发送该 origin，保留临时 HttpOnly cookie。原生 `/health` 请求使用独立 URLSession GET，无需 cookie、Origin 或认证令牌。导航策略允许同源路径与 query 变化，拒绝跨 origin 页面、弹窗和 iframe。

宿主 PID 每秒检查；宿主退出后阿财自动退出。公开 `/health` 每 3 秒检查一次（单次超时 2 秒），连续 4 次失败后退出，不留下断线桌宠。

全屏独占、系统安全界面、锁屏等系统行为可能覆盖普通悬浮窗口；真实的多屏、全屏 Space、鼠标穿透与非抢焦点行为需要在目标 macOS 版本人工验收。未包含 Windows/Linux 伴随程序、独立升级器、分发公证或辅助功能权限申请。
