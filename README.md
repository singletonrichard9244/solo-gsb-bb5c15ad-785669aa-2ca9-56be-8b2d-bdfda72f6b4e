# ⌨ 上下文快捷键审校台（Node.js + React）

为命令式快捷键体系提供的可视化审校工具：建立**上下文树**，为命令指定所属上下文与由 **1～3 次按键**组成的序列；选择任一上下文后，系统按**最近祖先规则**构建生效绑定，自动标出**同层重复**与**前缀冲突**，并提供**逐键模拟器**实时查看候选、触发与等待状态。

## 一条命令启动（Docker Compose）

```bash
docker compose up --build -d
```

然后浏览器访问：

> **http://localhost:3000**

端口：主机 `3000` → 容器 `3000`（可在 `docker-compose.yml` 的 `ports` 中修改左侧端口）。
停止：`docker compose down`；数据保存在命名卷 `shortcut-data` 中，重建容器不丢失。

> 镜像启动时自动完成数据初始化：首次运行若数据文件不存在，会写入一套包含覆盖、同层重复、前缀冲突等场景的演示数据（`server/src/seed.js`）。

---

## 本地开发（无 Docker）

要求 Node.js ≥ 18。

```bash
npm install          # 安装全部依赖（npm workspaces：server / client）
npm run dev          # 并行启动后端(3000) 与 Vite 前端(5173)
```

访问 **http://localhost:5173**（Vite 已把 `/api` 代理到后端 3000）。

其他命令：

```bash
npm run build        # 构建前端到 client/dist
npm start            # 仅启动后端；若已 build，则由后端在 3000 端口托管前端
npm run test:engine  # 运行引擎单测（最近祖先 / 覆盖 / 重复 / 前缀 / 逐键模拟）
```

## 数据模型

| 实体 | 字段 |
|---|---|
| 上下文 Context | `id`, `parentId`（可空，支持森林）, `name`, `description` |
| 命令 Command | `id`, `contextId`（定义位置）, `name`, `sequenceTokens`（1~3 次按键）, `description` |

序列输入用**空格或逗号**分隔，每次按键支持组合键（修饰键 `Ctrl/Alt/Shift/Meta` + 一个主键），例如：

- `g l`（2 次按键）
- `Ctrl+Shift+P`（1 次按键）
- `Ctrl+K, x`（2 次按键，第 1 次为组合键）

## 审校规则

选定上下文后，沿其祖先链（自身 → 父 → … → 根）收集绑定：

1. **最近祖先生效，子级覆盖祖先**：同一序列若在链上多层定义，最靠近所选上下文的一层生效；祖先层的同序列绑定显示为「已覆盖（shadowed）」，不参与触发与冲突判定。
2. **同层序列重复 = 冲突（duplicate）**：同一上下文中多条命令使用完全相同的序列，双方（全部）都保留并会在按键时**同时触发**，列表标记「同层重复」，冲突卡片列出每一方的**来源上下文路径**与**最短触发输入**。
3. **前缀冲突（prefix）**：生效序列中若 `A` 是 `B` 的严格前缀（如 `G` 与 `G D`，允许跨层），双方分别标记「他序列前缀 / 前缀延伸」，冲突卡片同时展示双方来源与各自最短触发输入。
4. 兄弟上下文的绑定互不可见。

## 逐键模拟器

在右下录制区点击获取键盘焦点后直接按键（支持单键与组合键，单按修饰键不计入）：

- **Esc** 清空缓冲，**Backspace** 回退一个按键；
- `triggered`（绿）：缓冲精确命中，展示已触发命令（重复时列出全部）；若它同时是更长序列前缀，附候选提示；
- `waiting`（黄）：缓冲是一个或多个生效序列的前缀，列出候选命令、来源与「还差 N 键」；
- `no-match`（红）：既未精确命中也不是任何序列前缀；
- `idle`：尚未输入。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/state` | 全量上下文树与命令 |
| POST/PUT/DELETE | `/api/contexts[/:id]` | 上下文增改删（删除级联后代与其命令，移动时防环） |
| POST/PUT/DELETE | `/api/commands[/:id]` | 命令增改删，服务端校验序列合法性（1~3 键、组合键合法） |
| GET | `/api/review/:contextId` | 生效绑定、祖先链、冲突清单、shadowed 绑定 |
| POST | `/api/simulate/:contextId` | 逐键模拟，body：`{"buffer":["g","d"]}` 或 `{"presses":"g d"}` |

## 目录结构

```
.
├── Dockerfile                # 多阶段构建（构建前端 → 仅生产依赖运行）
├── docker-compose.yml        # 一条命令启动，端口 3000，命名卷持久化
├── server/
│   ├── src/
│   │   ├── index.js          # Express 入口、API、静态托管
│   │   ├── engine.js         # 核心规则：最近祖先/冲突/逐键模拟
│   │   ├── store.js          # JSON 文件持久化 + 校验
│   │   └── seed.js           # 初始演示数据
│   └── test/engine.test.js   # 引擎单测
└── client/
    ├── src/
    │   ├── App.jsx
    │   ├── api.js
    │   ├── styles.css
    │   └── components/       # 上下文树 / 命令面板 / 绑定与冲突 / 逐键模拟器
    └── vite.config.js
```
