# 0011 — 快照即 git 自动提交(作者 GALFree)

- **状态**: Accepted(2026-07-27,grill R5-Q1)

## Context

LLM 批量生成会毁稿,项目必须有回滚与审计。备选:插件自动 git 提交 / `.studio/history/` 自管快照 / 用户自理。git 本机可用(2.53,事实探测);项目全文本使 git 红利近乎免费,且工作台历史视图可直接骑在 `git log/diff` 上。

## Decision

写网关(ADR-0004)的每个**写批**(一批生成落盘、盖审读戳、素材写入)提交后,Host 同步执行一次本地 git commit,作者标识 `GALFree`,message 携带原因与上下文(环节、场景、素材槽、发起侧:工作台/agent/外部)。项目模板自带 git 初始化;`.studio/` 一并纳管。

## Consequences

- 审读、生成、修改的完整审计链免费获得;回滚 = revert/checkout,由 DSH 端工具暴露。
- 与用户自己的 git 使用**划界**:GALFree 只在自己的项目里自动 commit,永不 push、永不改写用户手动提交;建议用户把 remote 推送留给自己。
- 外部编辑器的未保存修改仍按"观察→刷新"(ADR-0004),commit 信息不代用户签名,避免 git 身份混淆。
