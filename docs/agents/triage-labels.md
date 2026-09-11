# Triage Labels — 默认词汇

五个标准角色,标签字符串与名称相同:

| 标签 | 含义 |
|---|---|
| `needs-triage` | 新到达,等待分流 |
| `needs-info` | 信息不足,等报告人补充 |
| `ready-for-agent` | agent 可直接开工 |
| `ready-for-human` | 需人类处理(设计决策、凭据、外部操作) |
| `wontfix` | 决定不做,留档 |

标签需在 GitHub 仓库首次创建后由 `gh label create` 补齐(setup 时执行)。
