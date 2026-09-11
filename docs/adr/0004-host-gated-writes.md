# 0004 — Host 单一写网关

- **状态**: Accepted(2026-07-27,grill 第 3 轮)

## Context

ADR-0003 把"同步"收缩为"写协调"。候选:(a) 插件内所有写(工作台 UI、agent 工具)都经 Host 项目服务串行落盘,文件监听仅用于观察**外部**修改;(b) 双方直接写盘 + 互相监听,后写覆盖或提示。

## Decision

**(a) Host 单一写网关**:项目文件的每次写由 Host 项目服务串行执行并携带版本戳(DSH `fs` 服务的 CAS 写入 `writeText(target, content, expected)` 是现成地基);工作台与 agent 都不绕过网关。VSCode/git 等外部修改经监听"观察→广播刷新",网关对版本漂移做冲突提示。

## Consequences

- 高频冲突(agent 与人在同一文件上交错)在网关内以版本戳解决;"真冲突"只剩外部编辑器这一低频边缘。
- 工作台的乐观更新必须等网关节奏(带版本确认),不能假写。
- 网关是天然的挂载点:撤销/历史、修改方审计、`.studio/` 一致性校验都在这一层做。
- 通信通道:工作台 Client ↔ 本插件 Host 路由(`webServer.register`),外部编辑器修改经文件监听(Windows 回环限制与本服务无关,文件监听走 Node watcher)。
