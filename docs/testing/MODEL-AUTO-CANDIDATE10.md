# 候选10：Git 模型 Auto 保存修复

版本：`0.3.6-uiqa.20261030.10`。基线：`c9f3253f9f7ad3a3f9c16971e112eb5c70eddf8b`（候选9代码与其后证据文档）。当前 main `a6f338e2028c10a10d53a8dd544d5294fabfa2f0` 是该基线的祖先；未回退既有功能或文档。

## 修复内容

- Git 模型从指定模型切回 Auto 后，保存明确清除旧 provider、model、reasoningEffort。JSON RPC 使用显式 `null` 表达清除；未提供的字段仍保留 partial update 语义。
- 切换到无推理强度的新模型时清除上一模型的旧强度。指定模型仍正常保存。
- Git 字段改为“模型 / Model”，Auto 选项改为“Auto／跟随宿主 / Auto / Follow host”。Local 模型默认行为与选项文字不变。
- 初始配置仍默认 Auto；不会自动抹掉用户现有显式模型。安装后需选 Auto 并保存，才执行清除。

## 本次验证（Linux 云端、Node 24.22.1）

| 验证 | 结果 |
|---|---|
| `npm run typecheck` | 通过 |
| `npm run build` | 通过 |
| `npm test` | 312 / 312 通过 |
| `node tests/run-model-route.mjs` | 5 / 5 通过，保留 Local 路由与选择器行为 |
| `npm run test:lifecycle-ui` | 通过，实际 React Local 输入生命周期 |
| `node scripts/test-private-git-model-settings.mjs --baseline` | 预期失败：只读加载候选9的两个原始源文件，Auto 保存后旧显式模型仍在真实 CoopCache 中 |
| `npm run test:model-settings` | 通过，下列相关集成链均覆盖 |

新增测试使用真实 React CoopPage 与 ModelPicker、ModeClient、CoopService、CoopCache、DSH DomainFacility 及 JsonStorageBackend。模拟 RPC 路由在双向强制 JSON 序列化，存储实际写入隔离临时目录；不是仅测纯函数或内存替身。

覆盖：初始 Auto；指定模型→Auto→保存→关闭重开；关闭缓存、服务和存储后端再新建实例读回；指定模型保存；更换供应商且新模型无 reasoningEffort；无关字段 partial 更新保持模型；重复 Auto 保存；中英文文案。候选9红对照失败点为旧模型仍在缓存，修复版对应断言通过。

边界：此轮不是完整 DSH 桌面宿主或 Windows 实机安装测试；未调用真实模型、GitHub、凭据或用户机器。已有实机及任务运行证据保留为历史证据，不冒称本轮重测。

## 交付与增量验收

见 `test-artifacts/candidate10/` 安装包及校验清单。沿用现有安装流程更新插件，打开 DSS-cah 设置：指定模型→Auto→保存→关闭重开，确认仍显示 Auto；再重载插件核对。只验证受影响设置链，无需重跑既有双十轮任务。此改动不要求发送模型请求。
