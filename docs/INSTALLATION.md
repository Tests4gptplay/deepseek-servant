# 安装与升级

## 安装

下载插件 TGZ 后，在运行 DSH 的电脑上保留该文件。在 **插件 → 添加插件 → 包名或地址** 中填写其完整绝对路径，无需解压。安装后启用插件，按宿主提示重启。

**升级与资料保留：** 先正常停止 DSS 执行并保留原数据备份。若宿主提示已安装，先卸载插件条目，再从 TGZ 安装。保留 DSH 数据目录、Local 库及任务工作区，不手工删除记录或数据。Desktop 需要时完整退出托盘进程后再打开；升级后检查设置、对话、任务记录与成果可读取。

**Web：** 先停止对应 profile，在运行该服务的环境执行，之后重启：

```sh
dsh plugin --profile web add '/absolute/path/deepseek-servant-0.5.0.tgz'
```

将示例替换为安装包在运行 DSH 的电脑上的实际绝对路径。Desktop 与 Web 分别管理安装。模型提供者与工具权限仍由 DSH 管理。

## 原生会话 Cleaner 的平台边界

Cleaner 与 DSS 由同一个包自动挂载，没有新增启用开关。macOS 自动清理尚未支持，DSS 仍可正常启动。

Cleaner 初始化失败会报告实际错误并保留普通缓存与 DSS 的使用；后续故障不因此停止仍在运行或 idle 的 Agent。Windows 完成逻辑删除后保留精确恢复记录，目录命名空间的断电持久性仍为未验证；技术回执可能随关闭的执行增长。它不删除权威 DSS 对话、任务原文或长期档案，也不按目录名扫除其他会话。

## Git 身份与连接

当前产品仅使用 **Dulwich 常驻内存 Git 后端**。运行 DSH 的环境需要 **Python、Dulwich 和 urllib3**，以及已登录授权账号的 **GitHub CLI（`gh`）**。内容读写仍走标准 Git HTTPS；连接身份与显式成员管理使用必要的平台 API。插件不会自行安装依赖，也不会在 Python 缺失时静默切换到磁盘或 Native 后端。仅使用 Local 模式不启动 Git helper。

建议使用官方 Python 的受支持版本建立独立虚拟环境。请从 [Python 官网](https://www.python.org/downloads/) 安装解释器，随后在源码或解压的包目录执行：

```sh
python3 -m venv .dss-git-venv
.dss-git-venv/bin/python -m pip install -r python/requirements.txt
.dss-git-venv/bin/python -m pip check
```

Windows PowerShell：

```powershell
py -3 -m venv .dss-git-venv
.\.dss-git-venv\Scripts\python.exe -m pip install -r python/requirements.txt
.\.dss-git-venv\Scripts\python.exe -m pip check
```

在 DSH 的本插件配置中将 `gitPythonExecutable` 设为上述虚拟环境 Python 的**完整绝对路径**；不再选择第二套 Git 后端。pip 会按所选 Python 和上游包的声明安装所需依赖。许可和代理配置见 [内存 Git 安装与实现](MEMORY_GIT.md)。

helper 在已有 Git 操作生命周期内按需启动，不阻塞插件注册；缺依赖会先报告，不重复花费账号/仓库 REST 查询。确认依赖修复后再次连接即可。每个仓库/authority 实例分别有后台读写、前台读写、界面刷新、Host 固定轮询和周期心跳发布七条独立通道，每条按约 40MiB 原始对象内容触发清理。活动快照和 UNKNOWN 写入仍受保护，40MiB 不是进程 RSS 或整个 Host 总内存上限；前台访问与后台连接可各有独立实例。

helper 保留 Host 已有的 HTTP(S)/ALL/NO_PROXY 与 CA 路径选择，支持 HTTP/HTTPS CONNECT 代理和显式 CA，强制 TLS/主机名验证，不修改系统网络或信任。NTLM/Kerberos、SOCKS 和复杂 CIDR NO_PROXY 不受支持；不同平台的信任配置可能需要适配；遇到不支持配置应报告，不静默绕过代理。凭据只由既有授权源通过进程管道提供，不进入命令行、磁盘或日志。DNS 使用只接收主机、端口和地址族、继承受限运行环境的短生命周期子进程，不向其传入仓库 token 或代理凭据。取消会终止并回收对应 DNS 子进程、唤醒连接等待，并中断该请求仍拥有的底层 socket，包括 TLS；其他已热对象读取仍有独立执行资源。传输不设固定超时，等待完成、实际失败或取消，不保证取消返回时全部清理已经结束或凭据内存已擦除。

产品 Git 不需要 `git` 可执行文件，不卸载用户现有 Git 或 gh。

Windows 安装 GitHub CLI：

```powershell
winget install --id GitHub.cli --source winget
```

安装后打开新的终端窗口，登录并检查当前账号：

```sh
gh auth login --hostname github.com --web
gh auth status --hostname github.com
```

当前账号需有目标私库的读写权限。在 DSS 的 Git 设置中填写仓库与目录，点击 **保存并连接**；成功提示表示设置已保存且连接登记成功。CLI 未安装、未登录或仓库授权不足时会显示实际错误，完成配置后再保存。**开始协作后台／退出协作后台** 控制后台参与；普通历史读取和发送消息不自动恢复已退出的后台。

Git 协作的全局前台回复与顶层任务初始投递入口由**仓库所有者账号的主理实例**负责：该实例须在线并已开始协作后台。主理实例是此账号在同一仓库、分支和目录中登记后使用账号原名的实例。其他有写权限的协作者实例加入同一范围参与协作；已明确分派到其他实例的 O 任务及其 Recorder、Cleaner 由该任务的实际 owner 实例处理，无需成为全局主理者。新建协作域或更改显示名称不改变主理资格。

**Git setup:** Global Foreground replies and initial admission of top-level task sources run on the **repository owner's primary instance**, which must be online with background participation enabled. This is the instance registered under the owner's exact account name in the same repository, branch, and directory. Other collaborators with write access can join that scope. An O task explicitly assigned to another instance, together with its Recorder and Cleaner, runs on that task's actual owner instance without requiring global-primary status. Creating a collaboration or changing a display name does not change primary ownership.

参考：[GitHub CLI Windows 安装](https://github.com/cli/cli/blob/trunk/docs/install_windows.md)、[GitHub CLI 登录](https://cli.github.com/manual/gh_auth_login)。
