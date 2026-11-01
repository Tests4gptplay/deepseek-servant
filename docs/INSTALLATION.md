# 安装与升级

本工作分支是尚未发布的统一框架候选，包内版本号暂仍为 `0.4.1`。下面固定标签及下载地址指向历史发布版，不包含本次改造；历史 Windows Desktop 模型设置和任务运行验证不代表当前候选通过验收。

## 历史发布版的原生安装

历史发布版：**0.4.1**。该安装包与固定标签均已包含运行文件，无需编译。

**首次安装（Desktop）：** 打开侧栏 **插件 → 添加插件**（箭头菜单的 **安装第三方插件** 也可进入），把下面一整行填入 **包名或地址**，点击 **安装**，核对版本后点击 **立即启用**。

```text
github:Tests4gptplay/deepseek-servant#v0.4.1
```

**升级已有插件：** 同样填写上面的新版来源，成功后核对版本并启用；已有设置与用户文件保留。若宿主提示已安装或要求先卸载，再按提示仅卸载该插件条目并安装新版，不清除 DSH 数据或手工删除插件目录。是否需要重启以 DSH 提示为准；需要时完全退出并重新打开（Desktop 包括托盘）。

启用后从侧栏打开 DeepSeek Servant。当前候选的模型、工作区和参与设置见 [使用说明](USAGE.md)。

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

## 当前候选的 Git 身份与连接

准备 GitHub CLI（`gh`），让运行 DSH 的环境能够找到该命令并使用已授权账号。当前候选通过 GitHub API 直接读写远端提交、树与 blob，不在本地维护 Git 镜像或工作树；Git CLI 不是该业务存储路径的同步执行器。

Windows 安装 GitHub CLI：

```powershell
winget install --id GitHub.cli --source winget
```

安装后打开新的终端窗口，登录并检查当前账号：

```sh
gh auth login --hostname github.com --web
gh auth status --hostname github.com
```

当前账号需有目标私库的读写权限。在 DSS 的 Git 设置中填写仓库与目录，点击 **保存并连接**；成功提示表示设置已保存且连接登记已读回。CLI 未安装、未登录或仓库授权不足时会显示实际错误，完成配置后再保存。**开始协作后台／退出协作后台** 控制后台参与；普通历史读取和发送消息不自动恢复已退出的后台。

参考：[GitHub CLI Windows 安装](https://github.com/cli/cli/blob/trunk/docs/install_windows.md)、[GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login)。

## 当前候选的构建与安装核验

使用包内声明的 Node.js `^22.19.0 || >=24.0.0`：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm pack --ignore-scripts
```

构建将角色提示、样式及美术资源嵌入生产文件。安装包由 files 白名单控制，测试和开发验证材料不进入运行包。用固定提交构建的候选 `.tgz` 完整路径安装，不使用上面的历史标签冒充候选。候选安装仍需核对宿主、依赖、提交与实际包；完整 Host、模型执行及 Desktop／Web 验收不能由历史版本测试代替。构建和包验证范围见 [TESTING](TESTING.md)。
