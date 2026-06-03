# HappyCodex Web API 参考

> 修改或新增 API 端点时请同步更新本文档。

## 认证

- `GET /api/auth/status` — 系统初始化状态（`initialized`、是否有用户）
- `POST /api/auth/setup` — 创建首个管理员（仅用户表为空时可用）
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me`（含 `setupStatus`）
- `POST /api/auth/register` · `PUT /api/auth/profile` · `PUT /api/auth/change-password`

## 群组

- `GET /api/groups` · `POST /api/groups`（创建 Web 会话）
- `PATCH /api/groups/:jid`（重命名） · `DELETE /api/groups/:jid`
- `POST /api/groups/:jid/reset-session`（重建工作区）
- `GET /api/groups/:jid/messages`（分页 + 轮询，支持多 JID 查询）
- `POST /api/messages`（向工作区发送消息；首字符 `/clear` 触发会话重置，返回 `{ success: true, cleared: true }`）
- `GET|PUT /api/groups/:jid/env`（群组级容器环境变量）

## 文件

- `GET /api/groups/:jid/files` · `POST /api/groups/:jid/files`（上传，50MB 限制）
- `GET /api/groups/:jid/files/download/:path` · `DELETE /api/groups/:jid/files/:path`
- `POST /api/groups/:jid/directories`

## 记忆

- `GET /api/memory/sources` · `GET /api/memory/search`（全文检索）
- `GET|PUT /api/memory/file`

## 配置

- `GET /api/config/codex/status`（读取 `data/sessions/main/.codex` 的隔离 Codex runtime 登录状态）
- `PUT /api/config/codex/api-key`（通过 `codex login --with-api-key` 登录隔离 runtime）
- `POST /api/config/codex/logout`（退出隔离 runtime）
- `GET|PUT /api/config/feishu`（**deprecated**，使用 `/api/config/user-im/feishu` 代替）
- `GET|PUT /api/config/telegram` · `POST /api/config/telegram/test`（**deprecated**，使用 `/api/config/user-im/telegram` 代替）
- `GET|PUT /api/config/appearance` · `GET /api/config/appearance/public`（外观配置，public 端点无需认证）
- `GET|PUT /api/config/system` — 系统运行参数（容器超时、并发限制、`autoCompactWindow` 等），需要 `manage_system_config` 权限
- `GET /api/config/user-im/status`（所有渠道连接状态，含 QQ）
- `GET|PUT /api/config/user-im/feishu`（用户级飞书 IM 配置，GET 返回 `connected` 字段）
- `GET|PUT /api/config/user-im/telegram`（用户级 Telegram IM 配置，GET 返回 `connected`、`effectiveProxyUrl`、`proxySource`，PUT 支持 `proxyUrl`/`clearProxyUrl`）
- `POST /api/config/user-im/telegram/test`（Telegram Bot Token 连通性测试，使用 per-user proxyUrl）
- `GET|PUT /api/config/user-im/qq`（用户级 QQ IM 配置，GET 返回 `connected` 字段）
- `POST /api/config/user-im/qq/test`（QQ 凭据连通性测试）
- `POST /api/config/user-im/qq/pairing-code`（生成 QQ 配对码）
- `GET /api/config/user-im/qq/paired-chats`（已配对的 QQ 聊天列表）
- `DELETE /api/config/user-im/qq/paired-chats/:jid`（移除 QQ 配对）
- `GET|PUT /api/config/user-im/dingtalk`（用户级钉钉 IM 配置，GET 返回 `connected` 字段）

## 任务

- `GET /api/tasks` · `POST /api/tasks` · `PATCH /api/tasks/:id` · `DELETE /api/tasks/:id`
- `GET /api/tasks/:id/logs`

## 管理

- `GET /api/admin/users` · `POST /api/admin/users` · `PATCH /api/admin/users/:id`
- `DELETE /api/admin/users/:id` · `POST /api/admin/users/:id/restore`
- `POST /api/admin/invites` · `GET /api/admin/invites` · `DELETE /api/admin/invites/:code`
- `GET /api/admin/audit-log`
- `GET|PUT /api/admin/settings/registration`

## Sub-Agent

- `GET /api/groups/:jid/agents` · `POST /api/groups/:jid/agents`（创建 Sub-Agent）
- `DELETE /api/groups/:jid/agents/:agentId`

## 目录浏览

- `GET /api/browse/directories`（列出可选目录，受挂载白名单约束）
- `POST /api/browse/directories`（创建自定义工作目录）

## Plugin APIs

当前接口继承自 HappyClaw 的 plugin catalog/runtime snapshot 设计：admin 共享导入的 catalog（immutable，按内容 hash 寻址） + per-user enable refs + per-user versioned runtime snapshot。Codex-specific plugin/resource 迁移只能发生在 runner/runtime 边界，不应重写周边产品壳。

| Method | Path | Auth | 用途 |
|--------|------|------|------|
| `GET` | `/api/plugins` | 登录 | 返回 catalog 全集 + 当前用户 enabled 状态投影（一次取齐前端列表所需数据） |
| `GET` | `/api/plugins/catalog` | 登录 | catalog 索引（`marketplaces[].plugins[].versions[]` 元数据） |
| `GET` | `/api/plugins/catalog/marketplaces/:mp` | 登录 | 单个 marketplace 详情 |
| `POST` | `/api/plugins/catalog/scan` | admin (`manage_system_config`) | 扫描宿主机外部资源目录下的 `plugins/marketplaces` 并入 catalog；返回 `ImportReport`（`marketplaces` / `plugins` / `created` / `skipped`）。开启自动扫描后，主进程启动 5s 后 + 每小时自动调用同一逻辑 |
| `PATCH` | `/api/plugins/enabled/:fullId` | 登录 | body `{ enabled: boolean }`，read-modify-write `users/{userId}/plugins.json`；启用时自动 `materializeUserRuntime` 写入 `runtime/{userId}/snapshots/{snapshotId}/`；UI 必须提示"下次新会话生效" |
| `POST` | `/api/plugins/materialize` | 登录 | 手动重建当前用户的 runtime snapshot（用于 catalog 更新后强制刷新） |
| `DELETE` | `/api/plugins/marketplaces/:name` | 登录 | **NOT a catalog deletion** — 仅清理调用者自己的 `enabled.*@{name}` 引用，共享只读 catalog 不动（admin 共享导入、按内容 hash 寻址） |

**已废弃**（PR1 删除，新代码不要引用）：~~`POST /api/plugins/sync-host`~~、~~`GET /api/plugins/available-on-host`~~。

## 用量统计

- `GET /api/usage/stats?days=7&userId=&model=`（从 `usage_daily_summary` 查询，支持用户/模型筛选）
- `GET /api/usage/models`（去重模型列表）
- `GET /api/usage/users`（有用量数据的用户列表，admin 可见全部）

## 监控

- `GET /api/status` · `GET /api/health`（无需认证）

## WebSocket

- `/ws`（消息流、状态更新和 IM 绑定事件）
