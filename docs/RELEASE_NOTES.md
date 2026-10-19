# 阿财 0.1.0

配套财神主题的 DSH 桌面宠物首版。独立透明窗口跨应用悬浮，展示任务运行、待确认、本轮结束和问题状态，支持摸头、打盹、求签、金币动画，以及返回刚才的 DSH 聊天。

适配 DSH **0.2.1-rc.2**、**macOS 13+**。已包含 Apple Silicon／Intel 通用伴随程序，无需安装 Xcode、运行构建脚本或首次启动下载。Windows／Linux 暂不支持。

在 DSH「插件」→「添加插件」填入：

```text
git+https://github.com/MrGuang123/dsh-pet-caishen.git#v0.1.0
```

安装完成后启用，按提示刷新或重启 DSH。也可下载本页的 `dsh-pet-caishen-0.1.0.tgz`，在添加插件时填入下载文件的绝对路径；`SHA256SUMS` 提供该包的 SHA-256。

插件与财神主题可分别启用。只使用任务标题、状态及交互标志，不读取消息正文、推理或工具参数，不发送遥测；本轮结束不代表测试或工作结果已验证。

预编译程序为 ad-hoc 签名，未做 Developer ID 公证。本机验证环境为 Apple Silicon；Intel、多屏接拔、全屏 Space 和持续拖动手感仍需更多实机反馈。遇到问题请附上 macOS、CPU、DSH 版本和错误文字，在仓库 Issues 反馈。
