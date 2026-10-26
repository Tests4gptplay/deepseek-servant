# 安装、升级与开发构建

当前开发候选：`0.1.0-alpha.40`，包含独立 Private Git 实验模式。当前仓库用于私有开发，固定版本发布与插件市场发布另行安排。

## 1. 环境

- 已验收宿主：Windows / DSH `0.2.1-rc.3`；早期 Linux / `0.2.1-rc.2` 记录见[实现说明](../IMPLEMENTATION.md)。
- Node.js 按包内声明使用 `^22.19.0 || >=24.0.0`；开发测试建议 Node.js 24。
- 模型提供者、工具权限、preset 和凭据由 DSH 配置。Servant 使用宿主已有的原生能力。

## 2. 安装 alpha.40 开发候选

使用 DSH 原生插件管理入口安装 `deepseek-servant-0.1.0-alpha.40.tgz`。在 Desktop 的“插件 → 添加插件”中输入包的完整路径，安装并启用；命令行等价操作为：

```sh
dsh plugin --profile desktop add "<候选 tgz 的完整路径>" --ignore-scripts
```

Web profile 使用同一原生命令，将 `desktop` 换成实际 profile 名，例如 `web`。操作更新指定 profile；已有配置、Domain 和记录目录继续使用。安装后进入侧栏 DeepSeek Servant，按[使用指南](USAGE.md)选择模型和工作区。

候选包附带 SHA-256 与包内容核对结果，协作运行记录见[alpha.40 开发验收](acceptance-private-git-20261026.md)。已有 alpha.39 包及其[验收记录](acceptance-20261026.md#安装包与保存)继续保留。

## 3. 固定版本来源约定

正式版本沿用 DSH 原生 GitHub 来源：Desktop“插件 → 添加插件”使用发行说明给出的 `github:Tests4gptplay/deepseek-servant#<固定版本>`；Web 使用 `dsh plugin --profile web add '<同一固定来源>'`。固定来源和可安装产物在该次发布时一起确定。

alpha.40 当前以开发候选包交付，安装时指定该次交付的包路径；正式固定版本来源随发布提供。

## 4. 从源码进行开发构建

在仓库根目录显式运行：

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build
npm pack --ignore-scripts
```

构建生成 `lib/host.js` 与 `lib/client.js`，打包由 `package.json` 的 `files` 白名单控制。源代码中的角色契约在构建时嵌入 Host；原生 DSH 运行组件由宿主提供。

开发构建用于检查当前源码；重新交付安装包时使用新的版本与相应验收记录，保留旧候选的文件和校验和。

### 按改动选择验证

| 命令 | 范围 |
| --- | --- |
| `npm run typecheck` | TypeScript 静态类型 |
| `npm test` | 领域、记录、接续、恢复及状态逻辑的源码回归 |
| `npm run test:history-ui` | React 页面、官方组件、历史阅读位置和日历交互 |
| `node tests/run-model-route.mjs` | 模型路由与选择器初始状态的专项开发检查 |

以上均为显式开发命令。alpha.40 的源码与原生协作结果见[开发验收](acceptance-private-git-20261026.md)；Local 的原生恢复及 31 分钟静默作业继续沿用[alpha.39 验收记录](acceptance-20261026.md)。
