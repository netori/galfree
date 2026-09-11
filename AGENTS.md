# AGENTS.md

DSH **GALFree** 插件:在 DSH 里自动化制作 Ren'Py galgame 的全流程工作台。

## Agent skills

### Issue tracker

Issues 在 GitHub(`netori/galfree`,gh CLI);阻塞关系用 body 的 `## Blocked by` 小节。见 `docs/agents/issue-tracker.md`。

### Triage labels

默认五角色词汇(needs-triage / needs-info / ready-for-agent / ready-for-human / wontfix)。见 `docs/agents/triage-labels.md`。

### Domain docs

Single-context:根 `CONTEXT.md` 为 glossary,`docs/adr/` 存 ADR。开工前读两者。见 `docs/agents/domain.md`。

## 硬约束(来自 ADR,违反前先提 ADR 修订)

- 项目文件的一切写必须走 Host 写网关;`.rpy` 是叙述与分支结构的唯一真相,`.studio/` 永不复制叙述内容(ADR-0003/0004/0009)。
- 进度是推导的,不是手写的;审读戳只能由人盖,重生成清戳(ADR-0008)。
- 不依赖 dsh-imagegen;出图走插件自建图像子系统的任务队列(ADR-0010)。
- Ren'Py SDK 用钉版(ADR-0006);v1 项目只从模板新建(ADR-0005)。
