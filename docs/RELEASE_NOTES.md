# 阿财 0.2.0-rc.4

DSH `0.2.2-rc.2` 兼容与首次点击拖拽修复预发布版。本版让阿财在 rc.2 的插件组合中正常激活，并修复非激活状态下必须先点一次、第二次才能拖动的问题；2D 体验与原生程序功能保持 `0.2.0-rc.1`。整体阶段仍有实机验收待办，本版不标记为稳定版；3D 继续后置。

适配 DSH **0.2.2-rc.2**、**macOS 13+**；`engines.dsh` 覆盖 `0.2.1-rc.5` 起的整条 0.2.x。内置 Apple Silicon／Intel 通用伴随程序，无需 Xcode、构建脚本或首次启动下载；Windows／Linux 暂不支持。

- `0.2.2-rc.2` 移除了 `AgentRegistry.roots()`。适配器保留旧版路径，rc.2 使用 `list()` 并按 session header 的 `origin: subagent` 排除子代理；普通用户 fork 仍保留。新旧 registry 都有回归测试。
- 隔离 profile 启动 DSH `0.2.2-rc.2` 的 `dsh web`：组合无跳过、插件 Host 正常激活、`GET /pet-caishen/bridge` 返回 200 和可用桌面状态；本轮未运行真实任务。
- 修复首次点击拖拽：非激活 `NSPanel` 的第一次按下会被 AppKit 用于激活，`WKWebView` 默认拒绝该点击；新增 `CompanionWebView` 接受首次鼠标按下，并恢复可见期间 10Hz 光标轮询更新透明区穿透。用户完全退出并重开日常 DSH 后，已实机确认第一次按下即可直接拖动。
- 原生握手仍为 4、HTTP 状态仍为 v2、拖动协议不变；原生程序按 `0.2.0-rc.4` 重建，无需迁移既有偏好。

在 DSH「插件」→「添加插件」填入：

```text
git+https://github.com/MrGuang123/dsh-pet-caishen.git#v0.2.0-rc.4
```

也可下载本页的 `dsh-pet-caishen-0.2.0-rc.4.tgz`，在添加插件时填入下载文件的绝对路径；`SHA256SUMS` 提供该包的 SHA-256。升级后必须完全退出并重新打开 DSH，让新 bundle 和新原生程序生效；仅刷新页面不会重载宿主插件树。

本插件只使用任务标题、状态及必要交互标志，不读取消息正文、推理或工具参数，不发送遥测。本轮结束不代表测试或工作结果已验证。主题与宠物可以分别启用；同级财神主题若仍声明旧范围，需要在其仓库同步放宽，否则会被单独跳过。

已完成自动回归、原生构建、干净打包与隔离 rc.2 宿主加载；首次点击拖拽已由用户在重启日常 DSH 后实机确认。本轮**未重新执行浏览器客户端加载**（无登录凭证），也未运行真实任务、审批／提问或导航；完整 DSH 界面流程、Intel 实机、多屏／全屏 Space、连续拖动／穿透／快捷键、VoiceOver 和睡眠唤醒等专项仍待验收，详情见 [验证记录](https://github.com/MrGuang123/dsh-pet-caishen/blob/v0.2.0-rc.4/docs/VALIDATION.md)。跨 profile 使用时需配置不同 instanceId 或独立 stateDirectory。预编译程序为 ad-hoc 签名，未做 Developer ID 公证。
