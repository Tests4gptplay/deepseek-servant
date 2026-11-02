# 安装与升级

## 安装测试版 RC2

在 DSH 的 **插件 → 添加插件 → 包名或地址** 输入固定来源：

```text
github:Tests4gptplay/deepseek-servant#v0.5.0-rc.2
```

[RC2 Release](https://github.com/Tests4gptplay/deepseek-servant/releases/tag/v0.5.0-rc.2) 提供备用安装包 [deepseek-servant-0.5.0-rc.2.tgz](https://github.com/Tests4gptplay/deepseek-servant/releases/download/v0.5.0-rc.2/deepseek-servant-0.5.0-rc.2.tgz)。可将该下载地址填入同一个输入框，或下载后填写运行 DSH 的电脑上文件的完整绝对路径，无需解压。安装后启用插件。

包内版本显示 **0.5.0**，本测试候选由固定标签 **v0.5.0-rc.2** 标识。RC1 同样显示 0.5.0，升级时应核对安装来源变为 RC2。

**升级：** 先停止 DSS 任务并保留原数据。填写上面的 RC2 来源；若宿主提示已安装，先在插件管理中卸载该插件条目，再安装 RC2。保留 DSH 数据目录、Local 库及任务工作区，不执行记录清理或手工删除数据。按宿主提示重启；Desktop 需要时完整退出托盘进程再打开。升级后检查原设置、对话、任务记录与成果可读取。

**Web：** 在运行服务的环境停止对应 profile 后执行，再重新启动该 profile：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.5.0-rc.2'
```

使用 Release 资产时，将命令中的来源换成对应 TGZ 下载地址。Desktop 与 Web 分别管理安装。启用后从侧栏打开 DeepSeek Servant，详见[使用说明](USAGE.md)。模型提供者与工具权限由 DSH 管理。

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
