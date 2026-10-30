# 可查验用例与结果

对应源版本：[固定候选提交](https://github.com/Tests4gptplay/deepseek-servant/commit/5671c7f23fabb1dec04e8724e2da437ff60adacb)。下列记录来自既有执行，不是再次测试。

源码312项为汇总；公开JSON提供双十轮与五专项真实结果摘录，不包含模型或公网GitHub性能承诺。共享conversation自动消费和Git多事务优化属于后续设计，不列为本次功能。

| 范围 | 操作步骤 | 预期 | 实际结果与环境 |
|---|---|---|---|
| Local10 | 一个任务连续Planner→两Worker→Planner十轮 | 20项成果、原页自然交付、owner收尾 | 实际Host与存储通过；跨两次重启保原页，无刷新重发。 |
| Git10 | 同一任务十轮，注入CAS/fetch/push故障 | 真实Git失败后继续，最终20接受 | 真实退出码1/128/128，十轮完成；JSON保留边界中断与结果计数。 |
| 五恢复专项 | cancel迟到、revise旧结果、重复结果、provider故障、storage EEXIST | 无错归属/重复效果，恢复后owner结清 | 五组最终revision36/62/46/57/44，各owner settled且uncertainActions0。 |
| 更新中UI | Git新计划/结果尚未发布，再等待发布 | 显示更新中，不误称无成果；已确认结果保留 | Light/Dark实际观察通过，发布后自然回到成果；执行协议未改。 |

## 公开证据

[净化用例结果 JSON](evidence/verified-cases.json)，SHA256 `650241ac1f8d80ed8a65d8394b7598036fef5d8357c2f3467fcf787091f070eb`。文件保留测试环境、实际时间/状态/计数及原证据文件SHA；删除账号内容、机器目录、会话标识、原始日志和截图。

原证据SHA用于标识摘录来源；原件不在本仓时，不把SHA冒充可公开下载的原件。历史组件总数仅按现有摘要记录，未凭空补出逐用例执行记录；具体实现与测试可从固定提交继续查验。已有结果与[实机验证要求](ACCEPTANCE.md)分开。
