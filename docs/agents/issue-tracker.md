# Issue Tracker — GitHub

本仓库的 issues 存放在 **GitHub Issues**(`netori/galfree`),通过 `gh` CLI 读写。

## 约定

- 创建 issue:`gh issue create --title "..." --body-file <file> --label <labels>`
- 读取:`gh issue view <n>` / `gh issue list --state open`
- Body 中含 markdown 的,一律 `--body-file`,不做行内转义。

## Blocking edges

Ticket 之间的阻塞关系用 GitHub 原生 issue 依赖不可靠(无原生 API 语义),因此**双轨**:

1. issue body 顶部固定小节 `## Blocked by`,逐行列出依赖 issue 的 `#<number>`(创建顺序保证编号已知;无依赖则写 `无`)。
2. 领取前的机械检查:`gh issue view <n>` 里 `Blocked by` 的每个编号必须已 closed。

## Triage 纪律

- `to-spec` / `to-tickets` 产出的 issue 直接带 `ready-for-agent`,**不做** triage 流转。
- 新落进来的外部请求/bug 报告才走 `triage` skill。
