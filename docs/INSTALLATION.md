# 安装与升级

正式版本：`0.4.1`。模型设置已在 Windows Desktop `0.2.1-rc.5` 验证；任务运行的历史环境见验收记录。

## 原生安装

当前版本：**0.4.1**。安装包与固定标签均已包含运行文件，无需编译。

**首次安装（Desktop）：** 打开侧栏 **插件 → 添加插件**（箭头菜单的 **安装第三方插件** 也可进入），把下面一整行填入 **包名或地址**，点击 **安装**，核对版本后点击 **立即启用**。

```text
github:Tests4gptplay/deepseek-servant#v0.4.1
```

**升级已有插件：** 同样填写上面的新版来源，成功后核对版本并启用；已有设置与用户文件保留。若宿主提示已安装或要求先卸载，再按提示仅卸载该插件条目并安装新版，不清除 DSH 数据或手工删除插件目录。是否需要重启以 DSH 提示为准；需要时完全退出并重新打开（Desktop 包括托盘）。

启用后从侧栏打开 DeepSeek Servant，选择模型和工作区；DSS-cah 按需启用。

**备用安装包：** 将下面的 `.tgz` 直链填入同一个 **包名或地址**；也可下载后填写文件的完整绝对路径，无需解压。该路径应属于运行 DSH 的电脑。

```text
https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.4.1/deepseek-servant-0.4.1.tgz
```

**Web：** 在运行服务的环境中执行。升级前停止对应 Web profile，成功后重新启动；Web 与 Desktop 分别安装。

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.4.1'
```

备用时将命令中的来源换成上面的 `.tgz` 直链或下载文件的完整绝对路径。

模型、工具权限与预设由 DSH 管理。协作依赖见下节，仓库设置见 [DSS-cah 使用说明](../PRIVATE_GIT.md)。

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
