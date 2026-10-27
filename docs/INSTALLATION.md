# 安装与升级

正式版本：`0.3.0`；当前候选：`0.3.1-rc.2`。测试环境：Windows / DSH `0.2.1-rc.3`。

## 原生安装

Desktop 打开“插件 → 添加插件”，粘贴以下固定来源，安装并启用：

```text
github:Tests4gptplay/deepseek-servant#v0.3.0
```

Web profile 使用：

```sh
dsh plugin --profile web add 'github:Tests4gptplay/deepseek-servant#v0.3.0'
```

固定版本包含编译后的 Host 和 Client。升级沿用现有配置、存储 Domain、会话与记录目录。模型、工具权限和预设由 DSH 管理。

安装后进入侧栏 DeepSeek Servant，选择前台模型和工作区。页面齿轮与全局设置共用配置。标准模式可直接使用；DSS-cah 在实验性设置中按需启用。协作需要 Git 命令及目标私库的已有 GitHub 授权，配置步骤见 [DSS-cah 使用说明](../PRIVATE_GIT.md)。

Release 同时提供 `deepseek-servant-0.3.0.tgz` 与 SHA-256，作为备用安装包；也可通过同一插件管理入口安装该文件。

候选包 `deepseek-servant-0.3.1-rc.2.tgz` 也使用上述原生插件管理入口安装；安装该文件时版本为 `0.3.1-rc.2`。

## 开发

使用包内声明的 Node.js `^22.19.0 || >=24.0.0`：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm pack --ignore-scripts
```

构建将角色提示、样式及已接受美术嵌入生产文件。安装包由 files 白名单控制；测试、临时配置和开发验证按需显式运行。Local 的原生恢复与 31 分钟静默作业结果沿用 [alpha.39 验收](https://github.com/Tests4gptplay/deepseek-servant/blob/v0.3.0/docs/acceptance-20261026.md)。
