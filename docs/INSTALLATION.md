# 安装与升级

正式版本：`0.4.0`。最近设置增量验证环境：Windows Desktop `0.2.1-rc.5`；历史任务验证环境见验收记录。

## 原生安装

Desktop 打开“插件 → 添加插件”，粘贴以下固定来源，安装并启用：

```text
github:Tests4gptplay/deepseek-servant#v0.4.0
```

Web profile 使用：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.4.0'
```

固定版本包含编译后的 Host 和 Client。升级沿用现有配置、存储 Domain、会话与记录目录。模型、工具权限和预设由 DSH 管理。

安装后进入侧栏 DeepSeek Servant，选择前台模型和工作区。页面齿轮与全局设置共用配置。标准模式可直接使用；DSS-cah 在实验性设置中按需启用。协作使用 Git 和 GitHub CLI，依赖配置见下节，仓库设置见 [DSS-cah 使用说明](../PRIVATE_GIT.md)。

Release 同时提供 `deepseek-servant-0.4.0.tgz` 与 SHA-256，作为备用安装包；也可通过同一插件管理入口安装该文件。

## DSS-cah 依赖

准备 Git（`git`）与 GitHub CLI（`gh`），让运行 DSH 的环境能够找到这两个命令。Git 用于仓库同步，GitHub CLI 提供当前账号授权。

Windows 安装 GitHub CLI：

```powershell
winget install --id GitHub.cli --source winget
```

安装后打开新的终端窗口，登录并检查当前账号：

```sh
gh auth login --hostname github.com --web
gh auth status --hostname github.com
```

当前账号需有目标私库的读写权限。回到 DSS-cah 填写仓库与目录，点击“连接私有仓库”。CLI 未安装、未登录或仓库授权不足时，页面上方显示配置提示；完成配置后点击“重试”重新连接。

参考：[GitHub CLI Windows 安装](https://github.com/cli/cli/blob/trunk/docs/install_windows.md)、[GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login)。

## 开发

使用包内声明的 Node.js `^22.19.0 || >=24.0.0`：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm pack --ignore-scripts
```

构建将角色提示、样式及已接受美术嵌入生产文件。安装包由 files 白名单控制；测试、临时配置和开发验证按需显式运行。Local 的原生恢复与 31 分钟静默作业结果沿用 [alpha.39 验收](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-20261026.md)。
