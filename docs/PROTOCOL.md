# 本机桥接协议 v2

当前工作树使用 HTTP 状态 v2、偏好存储 schemaVersion 2、Native 握手 4。旧版 Native 程序会被拒绝，需要重建／安装完整程序。新契约见 [STATE_CONTRACT.md](STATE_CONTRACT.md)。

## 启动与认证

Native 从 stdin 第一行读取 `{launchURL,baseURL,parentPID,instanceId?}`。此后 stdin 保持打开，宿主可继续发送 `{"type":"animate","name":"coin"}`。launchURL 只允许 `http://127.0.0.1:<port>/launch?token=<secret>`，登录后换为 HttpOnly、SameSite=Strict cookie 并移除 URL 中凭证。日志不得输出 launchURL、token 或 cookie。

instanceId 仅允许 1–64 位字母、数字或连字符，用于独立 UserDefaults 域。宿主根据自己的 stateDirectory 与可选配置 instanceId 做哈希，不向 Native 传原始路径。多 profile 共用目录时需要分别设置 instanceId 或 stateDirectory；不自动读取 DSH profile 文件辨认归属。新域首次启动只迁移本应用旧域的有限窗口坐标，不复制任意字段。

## GET /api/state

```json
{
  "version": 2,
  "connection": { "connected": true, "lastSeen": 0, "mode": "dsh" },
  "activity": {
    "sessionId": "id", "title": "任务标题", "status": "running", "detail": "算盘拨起来了",
    "sourceId": "opaque-root-instance", "revision": 1, "updatedAt": 0,
    "turn": { "id": "opaque-turn", "startedAt": null, "endedAt": null, "endReason": null },
    "completion": null,
    "waiting": { "approval": false, "question": false, "unknown": false },
    "notificationId": null, "notificationPresented": false
  },
  "sessions": [],
  "navigation": { "lastSessionId": "previous-chat" },
  "preferences": {
    "schemaVersion": 2, "size": 160, "notificationMode": "all", "snoozedUntil": null,
    "quiet": false, "reducedMotion": false, "hidden": false, "mini": false,
    "largeText": false, "positionLocked": false, "dockEdge": false,
    "shortcutKey": "A", "onboardingSeen": false
  },
  "fortune": { "text": "宜小步提交，忌一把梭哈。" }
}
```

sessions 是相同结构的当前存活 root 列表；断连时为空。activity 是其中最高优先活动，或者无 sessionId 的 idle／offline 占位。turn 可为 null，时间可未知；endReason 只投影已核对的 completed／error／blocked／max-tokens／aborted／interrupted，其余统一 unknown。完成对象为 `{id,acknowledged}`，不表示测试通过。notificationId 用于 waiting／blocked／ready 提醒去重，notificationPresented 是宿主内存中的已展示标志，避免 WebView 恢复后重播；改名与时间变化不创建新完成身份。

## 修改与诊断

所有 POST 使用 `Content-Type: application/json`、`X-Acai-Client: companion-v1` 和同源 Origin，沿用随机 loopback、Host、cookie、请求大小校验。

- `POST /api/preferences`：允许 size、quiet（旧别名）、notificationMode、snoozedUntil、reducedMotion、hidden、mini、largeText、positionLocked、dockEdge、shortcutKey、onboardingSeen。拒绝未知字段和 schemaVersion patch；校验并原子保存成功后才发布新状态。
- `POST /api/action`：fortune、interact；open-session 可带 sessionId、completionId，气泡必须传捕获的目标；dismiss-reminder 必须带 sessionId、completionId，旧身份返回 409。不能提交命令、任意 URL、审批答案。
- `present-reminders`：entries 最多 300 条 `{sessionId,notificationId}`，只标记仍匹配的当前提醒已呈现；过期项忽略，不确认完成、不清除事实。
- `return-session`：不接受网页指定的新目标，仅返回宿主独立记住的上次聊天；没有记录时只唤回 DSH，不按活动优先级猜测。
- `GET /api/diagnostics`：仅白名单插件／目标 DSH／协议版本、平台架构、连接／可见／渲染就绪／快捷键状态和固定故障类型。不得返回标题、会话 ID、URL、路径、端口、原始异常或凭证；网页先预览，再由用户复制，不自动上传。
- `GET /health`：未认证的最小活性响应，维持独立 health version 1，不返回状态或偏好。

演示模式另有 `/api/demo`，接受六种业务状态、可选 title，以及白名单的 demo-session／demo-second，始终标注演示；真实 DSH 模式返回 404。

## DSH route /pet-caishen/bridge

保持同源 `X-Acai-Client: dsh-plugin-v1`：

- GET 返回 desktop、command 和当前 ready 的 `{sessionId,completionId}` 列表。desktop 区分 running、visible、rendererReady、shortcut 与脱敏错误。
- command 包含 id、sessionId、expectedCompletionId、expiresAt；有效期 20 秒，入队时固定目标与完成身份。
- navigation-ack 须匹配命令 id、sessionId 和时效；只确认 expectedCompletionId 对应的完成提醒，不清除明确错误或待处理交互。
- client-focus 发送 clientId、sessionId，供“返回刚才聊天”；有已观察到的当前完成身份时可附 observedCompletionId 消退对应提醒。只有客户端可见且聚焦时才报告选择。
- client-pending 只发送 sessionId 与 pending 布尔值；补正 8 秒过期，不覆盖宿主审批／提问事实。
- launch、toggle、animate/coin 保持固定动作白名单；不读取问题正文或工具参数。

## Native stdout 与消息

启动输出 `{"type":"hello","protocol":4,"version":"0.2.0-rc.1"}`，version 取本 App 的实际版本。随后按事实报告：

| stdout type | 数据 | 含义 |
| --- | --- | --- |
| visibility | visible:boolean | 窗口可见；不等于页面已渲染 |
| renderer | ready:boolean | 页面已可交互；故障恢复时先报告 false |
| shortcut | state:registered／conflict／disabled | 真实快捷键注册结果 |

宿主启动等待协议、可见与渲染确认；旧程序、缺少确认或退出均不能视为正常就绪。SIGUSR1／SIGUSR2 继续幂等唤回／收起。恢复重试有界，菜单栏可明确重新加载；原生 stdin／stdout 不含偏好之外的任务文字。

网页经 `window.webkit.messageHandlers.acai.postMessage` 发送以下消息，仅接受同源主 frame：

| type | 数据 | 用途 |
| --- | --- | --- |
| ready | 无 | 角色或静态备用形象已可交互 |
| settings | positionLocked、dockEdge、shortcutKey | 原生交互设置；shortcutKey 为 A–Z 或 null，修饰键固定 ⌃⌥⌘ |
| reset-position | 无 | 移回鼠标所在可用屏幕 |
| retry-renderer | 无 | 明确重试页面 |
| drag-start | id | 开始手势；1–1,000,000,000 的整数，锁定时拒绝 |
| drag-end | id、cancelled | 结束／取消同一手势 |
| resize | size | 角色缩放提示；原生 viewport 保持 420×440 |
| hide／quit／open-dsh | 无 | 收起／退出／唤回固定 bundle id |
| hit-zones | zones[{x,y,width,height}] | 可见交互区域；透明区穿透 |
| drag-bounds | left、right | 角色、状态条、悬停按钮的真实左右范围 |

Native 注入 `__ACAI_NATIVE__`，回传 acai-drag `{id,phase,moved,cancelled}`、acai-screen `{left,right}`、acai-visibility 布尔值及 acai-shortcut 状态。网页隐藏／休眠时暂停动画并降低轮询；仍保持宿主状态与生命周期检测。

拖动继续用 AppKit 全局鼠标坐标与按下时窗口原点作为固定锚点，5pt 阈值，不累加网页位移、不乘 Retina 倍率。只在手势中启动 60Hz common-mode 定时器兜底松手；静止时用鼠标事件更新穿透。位置在手势结束保存，边界回传去重。可选停靠只在真实移动后的正常松手执行，点击与取消均不吸边。
