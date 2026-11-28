# DSS 长线压力测试｜《鲸骨以北》

以游戏制作和验收作为持续负载，检验云环境、存储或模型供应中断后，DSS 能不能接回**同一个任务**，继续产出并归档。实测版本为 `0.5.2-test.2`，不是对 0.5.2 预发行包的一次重测。

整轮从委托下达到归档回执经过 **41 小时 46 分 42 秒**，含等待和恢复。原 Planner 实读 **71 次**交接。10 次环境或存储恢复后，原记录线 10 次、原制作线 7 次有新产出；制作线当时未接上的三次都源于同一个旧版缺陷。[接手阻塞已在本轮换版后解决](REPORT.md#owner-gate-resolved)，不是三个仍存在的问题。

## 公开材料

- [完整测试报告](REPORT.md) · [运行时间轴](TIMELINE.md) · [故障与收束记录](INCIDENTS.md)
- [行为观察与证据](DSS-BEHAVIOR-MATRIX.md) · [同步及回读台账](SYNC.md)
- [委托补充的送达与执行](internal/20261125T145419Z/changes.md) · [外部观察：中断与取证](external/20261125T145419743845Z/0012-continuity-priority-and-host-loss.md) · [外部观察：桥接发布环境](external/20261125T145419743845Z/0016-external-publisher-recovery.md)
- [归档引用复核](external/20261125T145419743845Z/native-close/root-archive-and-22-verified-references.json) · [原制作负责人续接成果](internal/20261125T145419Z/checks/real-game-planner-g11-receipt-and-first-new-integrated-work.json) · [缺失误报复核](internal/20261125T145419Z/checks/g14-self-correction-actual-five-native-results-and-independent-592-file-recheck.json)

## 证据范围

这里是原记录的公开版。委托补充用事实转述，保留时间、因果和执行结果；内部身份标识做了去识别处理。随附的 JSON 是运行证据摘录。完整原始请求与响应、会话附件、截图及试玩包仍在私有归档，未随本页公开。文中出现但无公开链接的资料名称，指该归档保留的材料。

[返回 0.5.2 增量验收](../../0.5.2.md)
