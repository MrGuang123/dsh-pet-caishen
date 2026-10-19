# 本机桥接协议 v1

Native 从 stdin 读取第一行 `{launchURL,baseURL,parentPID}`；此后 stdin 保持打开，宿主可继续写入一次性动画命令 `{"type":"animate","name":"coin"}`。launchURL 仅允许 `http://127.0.0.1:<port>/launch?token=<secret>`；成功登录后重定向到根路径，cookie 不对 JavaScript 开放。日志不得输出 launchURL、token 或 cookie。

## 状态

```json
{
  "version": 1,
  "connection": { "connected": true, "lastSeen": 0, "mode": "dsh" },
  "activity": { "status": "running", "sessionId": "id", "title": "任务标题", "detail": "算盘拨起来了", "updatedAt": 0 },
  "sessions": [{ "sessionId": "id", "title": "任务标题", "status": "running", "updatedAt": 0 }],
  "preferences": { "size": 160, "quiet": false, "reducedMotion": false, "hidden": false },
  "fortune": { "text": "宜小步提交，忌一把梭哈。" }
}
```

POST `/api/preferences` 接受 size（120–240）、quiet、reducedMotion。POST `/api/action` 接受 `{type:'fortune'|'interact'|'open-session',sessionId?}`。导航只能指向当前状态中已知的 sessionId。所有 POST 使用 `Content-Type: application/json`、`X-Acai-Client: companion-v1`。

悬停工具栏的「返回刚才的 DSH 聊天」使用 `{type:'return-session'}`。它只使用宿主记住的上次选中会话，不接收网页指定的任意目标，不按任务优先级选会话；尚无会话记录时只唤回 DSH。会话选择由 DSH 的 `uiSession.current` 订阅通过同源 `/pet-caishen/bridge` 的 `{type:'client-focus',clientId,sessionId}` 同步。记录只放内存，不保存正文或消息。

演示模式额外提供 POST `/api/demo`，接受六种业务状态与可选 title。真实 DSH 模式返回 404。

## Native stdout 与显示控制

- 启动后先输出一行 `{"type":"hello","protocol":3}`，宿主校验协议；缺少握手或协议不匹配时终止该进程并提示重新运行 `npm run build:macos`。原生协议 3 将拖动位置与松手检测交给 AppKit，替代网页位移累加；保留协议 2 的实际拖动范围与屏幕边界回传。HTTP 状态协议仍为 v1。
- 握手后只在可见性变化时输出 `{"type":"visibility","visible":true|false}`；宿主必须以真实上报更新开关，不能把“进程仍在运行”当作可见。
- 宿主用 SIGUSR1／SIGUSR2 幂等显示／收起；原生程序忽略这两个信号的默认终止行为，并保留菜单栏与快捷键入口。
- 宠物可见时，宿主可写入 `{"type":"animate","name":"coin"}`；原生程序在网页中播放一次性金币动画。动画不改变可见性、任务状态或功德计数。

## Native 消息

`window.webkit.messageHandlers.acai.postMessage(message)`：

| type | 数据 | 用途 |
| --- | --- | --- |
| ready | 无 | 页面准备完成 |
| drag-start | id | 开始一次左键手势；id 为 1–1,000,000,000 的整数 |
| drag-end | id, cancelled | 结束／取消对应手势；忽略不匹配的旧 id |
| resize | size | 角色尺寸提示；窗口 viewport 固定 420×440 |
| hide | 无 | 收起，保留菜单栏唤回 |
| quit | 无 | 退出伴随程序 |
| open-dsh | 无 | 只唤回固定 bundle id 的 DSH |
| hit-zones | zones[{x,y,width,height}] | 左上原点的实际交互区域；其余透明区域穿透 |
| drag-bounds | left, right | 宠物、状态条与悬停按钮占用的左右范围；透明留白可移到屏幕外 |

Native 注入 `window.__ACAI_NATIVE__ = true`。网页只在 Native 模式发送这些消息。原生窗口位置存储在原生 UserDefaults，与网页功能偏好分开。

原生在 `drag-start` 时记录 `NSEvent.mouseLocation` 与窗口原点，随后以两者为固定锚点，用同一 AppKit 全局坐标计算位置（单位为 point，Y 向上）；不使用网页 `screenX/screenY` 增量，也不乘 Retina 缩放倍率。移动超过 5pt 开始拖动；60Hz common-mode 定时器检测鼠标左键，网页丢失 `pointerup` 时也会在松手后结束，收起、屏幕配置变化或网页取消时终止手势。

原生通过 `acai-drag` DOM 事件回传 `{id,phase:'move'|'end',moved,cancelled}`。`move` 在首次超过阈值时发出，`end` 恢复网页交互；只有未拖动、未取消的结束才触发摸头，避免异步网页 click 把拖拽当作点击。网页丢失 pointer capture 不停止原生跟随，由原生按键检测兜底；浏览器预览仍由网页移动舞台。

原生窗口移动或收到 `drag-bounds` 后通过 `acai-screen` DOM 事件返回 `{left,right}`，表示该 WebView 在当前屏幕内的可见左右范围。设置与气泡据此向屏幕内展开。垂直方向继续按完整窗口约束，为设置保留空间。
