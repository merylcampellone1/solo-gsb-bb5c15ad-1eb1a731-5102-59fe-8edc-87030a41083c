# 排练字幕修订 Web 应用

本地运行的排练字幕（SRT）修订工具。导入 SRT 原稿后，可在**两条独立的修订分支**上修正文案与起止时间、拆分/合并片段；合并时按**来源片段**做三方比对，双方同时改动的片段会并列展示并由人工选择，未冲突改动自动保留。导出前强制时间线校验，并可随时查看/恢复原稿。

## 功能

- **导入 SRT**：严格校验序号连续、时间码格式、起点早于终点、片段不重叠；发现错误时列出具体行号与原因并**拒绝整份稿件**（不写入任何数据）。
- **双修订分支**：每份原稿导入时自动建立「修订分支 A / B」，各自独立编辑，互不影响。
- **片段编辑**：修改文案、起止时间；按时间码拆分片段；与下一片段合并；单片段恢复原稿；整条分支重置。
- **三方合并**：
  - 只被一方改动的来源区间 → 自动保留该方改动；
  - 双方都触及同一来源区间（含拆分/合并边界不同）→ 标记为冲突，并列展示 A/B 各自完整内容，必须逐处选择采用哪一方，**不以保存先后覆盖**；
  - 双方都未动 → 保留原稿；
  - 合并结果保存为新分支（含来源关联，可再次合并/导出）。
- **导出校验**：检查时间非负、起点早于终点、片段不重叠；失败时列出问题片段序号与原因，**不生成文件**；通过后导出序号从 1 连续编号的 SRT。
- **原稿管理**：在线查看原始 SRT、一键下载原稿、删除稿件。

## 技术栈

- 后端：Node.js 20 + Express
- 数据库：SQLite（better-sqlite3，同步事务，WAL 模式，外键级联）
- 前端：原生 HTML/CSS/JavaScript（无需构建）
- 部署：Docker / Docker Compose（多阶段镜像内含依赖安装与数据库自动初始化）

## 快速开始（Docker Compose，推荐）

需要 Docker 20.10+ 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后访问：

- **http://localhost:3000**

停止：

```bash
docker compose down          # 保留数据
docker compose down -v       # 同时删除数据库卷
```

### 配置

通过环境变量配置（可写入项目根目录的 `.env` 文件）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `APP_PORT` | `3000` | 宿主机映射端口（容器内固定监听 3000） |
| `PORT` | `3000` | 容器/进程监听端口（直接用 Node 运行时生效） |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | SQLite 数据库目录（Compose 中为命名卷 `/app/data`） |
| `DB_PATH` | `$DATA_DIR/app.db` | 数据库文件完整路径 |

例如改用 8080 端口：

```bash
APP_PORT=8080 docker compose up -d --build
# 访问 http://localhost:8080
```

数据保存在 Docker 命名卷 `srt-data` 中，重建容器不会丢失。

## 直接用 Node.js 运行（不使用 Docker）

```bash
npm install
npm start
# 访问 http://localhost:3000
```

数据库文件在首次启动时自动创建于 `./data/app.db` 并完成全部建表初始化，无需手动导入 SQL。

## 使用说明

1. 点击右上角 **导入 SRT**，选择本地 `.srt` 文件；若格式有误，弹窗会逐条列出「第 N 行」的错误，修正后重新导入即可。
2. 在顶部标签切换 **修订分支 A / B**，直接在表格中编辑文案与时间码，逐行点 **保存**；
   - **拆分**：输入切点时间码，把一条切成两条，两条均继承原来源；
   - **与下条合并**：合并相邻两条，来源取并集，时间取外边界，之后可再调整文案；
   - **恢复原稿**：把单条还原为原稿内容；**整条重置为原稿** 会丢弃该分支全部修改。
3. 两条分支修订完成后，点击 **合并两条分支**：
   - 预览每组来源区间的处理方式（未改动 / 仅 A 改 / 仅 B 改 / 冲突）；
   - 冲突处点击左侧或右侧卡片选择采用 A 还是 B，全部选择后生成合并分支。
4. 在合并分支（或任意分支）上点 **导出前检查**；通过后点 **导出 SRT** 下载序号连续的文件；检查不通过时按提示修复，服务器同样会拒绝生成文件。
5. 顶部 **查看原稿 / 下载原稿** 可随时对照与恢复原始稿件。

## SRT 格式要求

```
1
00:00:01,000 --> 00:00:04,000
第一句台词

2
00:00:04,500 --> 00:00:07,200
第二句台词（可多行）
```

- 序号必须从 1 开始且连续；
- 时间码格式 `HH:MM:SS,mmm --> HH:MM:SS,mmm`；
- 每条至少一行非空正文；
- 起点严格早于终点，相邻片段时间不重叠。

## 数据模型（简述）

- `scripts`：稿件与原始 SRT 全文；
- `source_segments`：解析后的原稿片段（合并识别的基准）；
- `branches`：修订分支与合并结果分支；
- `branch_segments`：分支上的当前片段；
- `segment_sources`：分支片段 ↔ 来源片段多对多关联（拆分=一对多，合并=多对一）。

合并算法以来源序号为轴遍历，依据双方在同一区间的区块（普通/拆分/合并）决定自动保留或提请冲突选择。

## API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/scripts` | 上传 SRT（multipart 字段 `file`，可选 `name`） |
| `GET` | `/api/scripts` | 稿件列表 |
| `GET` | `/api/scripts/:id` | 稿件详情（来源片段 + 分支） |
| `DELETE` | `/api/scripts/:id` | 删除稿件 |
| `GET` | `/api/scripts/:id/original[.srt]` | 查看/下载原稿 |
| `GET` | `/api/branches/:id` | 分支及片段 |
| `PATCH` | `/api/branches/:id` | 重命名分支 |
| `PATCH` | `/api/branches/:id/segments/:sid` | 改文案/起止时间 |
| `POST` | `/api/branches/:id/segments/:sid/split` | 拆分（`cut_ms`） |
| `POST` | `/api/branches/:id/segments/:sid/merge-with-next` | 与下条合并 |
| `POST` | `/api/branches/:id/segments/:sid/reset` | 单条恢复原稿 |
| `POST` | `/api/branches/:id/reset-all` | 整条重置 |
| `POST` | `/api/merge/preview` | 合并预览（冲突清单） |
| `POST` | `/api/merge/apply` | 提交冲突选择并生成合并分支 |
| `GET` | `/api/branches/:id/validate` | 导出前时间线检查 |
| `GET` | `/api/branches/:id/export` | 导出连续编号 SRT |

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── examples/
│   └── sample.srt    # 可直接导入试用的示例稿件
├── server/
│   ├── index.js      # Express 路由与业务接口
│   ├── db.js         # SQLite 连接与建表初始化
│   ├── srt.js        # SRT 解析 / 校验 / 序列化
│   └── merge.js      # 按来源片段的三方合并
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```
