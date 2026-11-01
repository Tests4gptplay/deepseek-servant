# 安装与升级

## 安装 0.5.0 候选包

当前 `0.5.0` 为候选，尚未发布 Release。使用实际收到并核对版本、SHA-256 的 `.tgz`；公开发行文件以 [Releases](https://github.com/Tests4gptplay/deepseek-servant/releases) 为准。

**Desktop：** 打开 **插件 → 添加插件**，在 **包名或地址** 填入运行 DSH 的电脑上候选 `.tgz` 的完整绝对路径。点击安装，核对版本后启用。包文件无需解压。

**Web：** 将包放在运行 Web 服务的环境中，停止对应 profile 后执行，再启动该 profile：

```sh
dsh plugin --profile web add '/absolute/path/deepseek-servant-0.5.0.tgz'
```

上面的路径是示例，请替换为实际文件。Desktop 与 Web 分别管理安装。

**升级：** 先保留 DSH 数据及用户文件，再按宿主提示安装新包。若提示先卸载，仅处理插件条目，保留数据目录。是否重启以宿主提示为准；Desktop 需要时完整退出托盘进程后重新打开。

启用后从侧栏打开 DeepSeek Servant，设置模型、预设、工作区和存储范围；详见[使用说明](USAGE.md)。模型提供者与工具权限由 DSH 管理。

## 历史发布版 0.4.1

需要历史版本时，可在包名或地址中使用：

```text
github:Tests4gptplay/deepseek-servant#v0.4.1
```

该版本对应[历史发布说明](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.4.1/docs/releases/0.4.1.md)与[历史使用说明](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.4.1/docs/USAGE.md)，不包含 0.5.0 统一框架功能。

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

## 从固定源码构建候选

使用 `package.json` 声明的 Node.js `^22.19.0 || >=24.0.0` 和对应依赖：

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run build
npm run test:package
npm pack --ignore-scripts
```

构建生成生产运行文件，测试与验证材料保留在开发树。安装前记录源码提交、依赖版本、包文件与 SHA-256，并核对包内版本。构建及包检查范围见 [TESTING](TESTING.md)。
