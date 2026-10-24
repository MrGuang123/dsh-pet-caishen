# 发布阿财

版本在 `package.json` 定义。正常用户从固定 GitHub 标签安装；仓库跟踪 `native/Acai.app`，所以 GitHub 安装无需构建钩子、Xcode 或运行时下载。`build/` 与 `output/` 仍为本地生成物。

1. 在 macOS 上修改版本、更新 CHANGELOG、README 安装地址和 `docs/RELEASE_NOTES.md`。
2. 运行以下检查：

   ```bash
   npm run build:client
   npm run prepare:native
   npm run check
   npm test
   npm run check:package
   npm run check:install
   ```

   `prepare:native` 用同一源码交叉编译 arm64 与 x86_64（最低 macOS 13），合并并签名，将分发 App 复制到 `native/`，记录版本、原生协议、源码和 App 全部文件的 SHA-256。`check:native` 在 Linux 和 macOS 均检查双架构格式、可执行权限及摘要；Swift 或构建脚本变化后必须重新生成。

   `check:install` 实际打包并解压到临时目录，确认没有 `build/` 时默认选择预编译程序、宿主模块可加载、协议／源码／二进制相符；macOS 上额外运行无 GUI 配置检查与签名验证。它不替代实际 DSH 任务与原生窗口验收。

3. 从干净 Git checkout 在临时 profile 用 DSH 的插件管理器安装，核对元信息、启用／停用、财运开关、真实任务状态、返回聊天和退出清理；不要修改日常 profile 来代替隔离验收。Intel 实机与多屏检查单独记录，未完成时不要声称已完成。
4. 将源码、`lib/client.js`、`native/Acai.app` 和 `native/manifest.json` 提交；确认无缓存、本机偏好或凭证。Git 必须保留 `native/Acai.app/Contents/MacOS/Acai` 的可执行位。
5. 推送提交与对应 `v<version>` 标签。标签工作流检查版本一致、完整测试、原生签名与干净安装，成功后发布 GitHub Release，附 `.tgz` 和 `SHA256SUMS`。不向 npm 发布，`private: true` 保留。
   带预发布后缀的标签（例如 `v0.2.0-rc.1`）会通过 `--prerelease --latest=false` 发布，保留既有稳定版；发布说明须列清楚未完成的实机验收，不能把候选版称为整体阶段已验收。

6. 检查 GitHub Actions 和公开标签安装地址实际可用，再从远端固定标签做一次临时目录安装。若失败，先修复再发布新版本，不覆盖已有版本标签或附件。

GitHub Actions 使用官方托管 runner 的 GitHub CLI 和限于当前仓库的 `GITHUB_TOKEN`，不需要将个人 token 放进仓库。使用说明见 [GitHub 官方文档](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-github-cli)。
