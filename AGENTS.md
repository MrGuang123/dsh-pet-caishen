# 阿财开发约定

- 产品范围以 `docs/PRODUCT.md` 为准；桌面悬浮是核心能力，网页演示不能替代原生验收。
- 目标 DSH 为 `0.2.1-rc.2`，macOS 原生最低版本为 13。扩大兼容范围前核对真实源码和实机行为。
- 不修改已安装 DSH App、日常 profile 或同级财神主题。宿主适配仅通过插件接口，桌面能力在自己的伴随程序内实现。
- 不读取或输出消息正文、工具参数、模型推理、登录凭证。只投影标题和状态；所有任务文字使用 `textContent` 或 React 转义。
- 审批／问题 observer 必须透明调用 `next()` 并原样传递结果／错误，不能替用户回答或批准。
- 只有真实 completed 结束原因才能显示“本轮结束”；不能推断测试通过。
- Native 与网页按 `docs/PROTOCOL.md` 协作，修改协议时同步两端与文档。
- 有行为变更时运行相关测试；交付前运行 `npm run check`、`npm test`，macOS 构建后运行 `npm run check:package`。只涉及文档时无需重复行为测试。
- 生成物放在忽略的 `build/` 与 `output/`，挑选的公开演示截图放在 `docs/screenshots/`。不提交本地偏好、凭证或缓存。
- GitHub 安装需要预编译程序：唯一纳入版本控制的分发产物是 `native/Acai.app` 与 `native/manifest.json`，由 `npm run prepare:native` 从 `build/` 生成，发布前用 `npm run check:native` 校验双架构、源码和二进制摘要。编译缓存仍不得提交。
- 验证记录必须区分离线测试、隔离真实运行库、浏览器预览、原生窗口和日常 DSH 完整安装。
