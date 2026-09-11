# GALFree(dsh-galfree)

在 DSH 里自动化制作 Ren'Py galgame 的全流程工作台插件。
领域语言见 [`CONTEXT.md`](CONTEXT.md),架构决策见 [`docs/adr/`](docs/adr/),
**环节零接缝契约**见 [`docs/contracts/stage-zero.md`](docs/contracts/stage-zero.md)。

## 状态

- ✅ 环节零(T1–T7):项目服务接缝、写网关、git 快照、方言子集解析器、
  假/真校验回路、钉版 SDK 供给、推导进度 + 审读戳、试玩控制、工作台
- ✅ 工作台面板:舞台板(场景 × 素材槽 × 印章)、文件树筛选、快照历史与 diff、
  SDK 供给卡;**审读戳可以盖到素材槽**(接缝早有 stampSlot,缺的是入口)
- ✅ 路由适配层契约测试(`src/service/routes.test.ts`):状态码映射 / 方法守卫 /
  SSE 帧 / 工作台实际调用的每个端点
- ⏳ 剧本环节(T8–T12)、素材环节(T13–T16)、音频/发布(T17–T18)

## 工程

```
src/
  index.ts            Host 半(cordis apply:路由/设置/装配)
  client/             工作台 Client 半(sidebar.panellist + main 面板)
    panel.tsx           面板本体(只渲染接缝状态,不自己判断进度)
    panel.module.css    设计令牌 + 版式(配色全走宿主 --dsw-* token)
    ui.tsx              Chip / 印章 / 提示条 / diff 视图
  routes.ts           /api/galfree 薄适配器
  service/            ★ 项目服务(seam)——独占逻辑全在这里
    project-service.ts   注册表 + 模板新建 + 全部环节方法
    write-gateway.ts     串行 CAS 原子批 + 外部观察(唯一写通道)
    snapshot.ts          写批后 git commit(作者 GALFree,永不 push)
    rpy/                 方言子集解析器 + 分支骨架派生(纯函数)
    validation/          校验回路契约 + 假验证器 + 真 SDK 适配器 + 合成端口
    sdk-provision.ts     钉版 SDK 下载状态机(校验和钉死)
    progress.ts stamps.ts playtest.ts registry.ts template.ts hash.ts
docs/contracts/       接缝契约(dialect-subset.md / stage-zero.md)
```

## 常用命令

```bash
npm run typecheck      # tsc --noEmit
npm test               # 快集成带(无网络、无真 SDK;78 tests)
npm run test:slow      # 慢集成带(真钉版 SDK lint/compile;发版前必跑)
npm run build          # lib/index.js(ESM host)+ lib/client.js(web bundle)
```

## 安装(人工验收)

以本仓库为插件源,按标准 DSH 插件流程安装(设置 → 插件 → 从本地/仓库添加);
装载后侧边栏出现「GALFree 工作台」入口。设置命名空间 `dsh-galfree` 可配
`defaultProjectsRoot`(新建项目默认父目录)与 `sdkPath`(既有 SDK 路径覆盖)。

## 硬约束(来自 ADR,改前先看契约文档)

- 项目文件一切写走 Host 写网关;`.rpy` 唯一真相;`.studio/` 永不复制叙述内容
- 进度是推导的;审读戳只能由人盖,重生成自动清戳(指纹失效即待复审)
- 不依赖 dsh-imagegen;SDK 用钉版;插件永不 push
