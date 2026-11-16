# DeepSeek Servant 0.5.0 RC4

本 RC4 采用已验证的 `0.5.0-rc.4-candidate.1` 实现，发布版本号规范为 `0.5.0-rc.4`。运行源码与预构建文件保持 candidate.1 原样，不包含后续 candidate.3 的 A1 同轮读取聚合改动。

## 本轮验证

- 云端 Linux 原生 DSH Local P/W 两轮完成写入、独立验收、成果交付及归档。
- 双 Host、真实 Git 的混合 O/O/P 与嵌套任务链完成，成果共享及清理核验通过。
- 受控阻塞专项保留无关写入解耦，同时等待自身及必要写入。

## 安装

DSH 插件添加来源：

```text
github:Tests4gptplay/deepseek-servant#v0.5.0-rc.4
```

这是 RC 预发布。附件包含安装包、完整源码快照及校验和。此次仅发布 GitHub，不发布 npm。
