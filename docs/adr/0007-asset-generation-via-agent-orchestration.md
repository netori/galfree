# 0007 — 素材生成走 agent 编排调 dsh-imagegen 工具

> **Superseded by ADR-0010**(2026-07-27,R5-Q2:发起人要求自建系统化生图,不依赖 dsh-imagegen)。角色登记簿作一致性锚的决定不受影响(见 CONTEXT 与 ADR-0010);"何时需要模型判断"的问题移交 ADR-0010 的 R6-Q1。

- **状态**: Superseded(原 Accepted 2026-07-27,grill 第 3 轮)

## Context

事实:dsh-imagegen 不暴露 Host Service,其出图能力对 agent 的接口是 `generate_image`/`edit_image` 工具,渠道与密钥在其私有设置文档。

## Decision(已被 0010 取代)

v1 素材环节由 agent 编排:Host 拉起子 agent 调 dsh-imagegen 工具出图,经写网关落盘。
