# 生产 PostgreSQL 配置

## 支持模式

生产 Compose 通过 `QM_DATABASE_MODE` 明确选择数据库拓扑。

| 模式       | 必需配置                                                                  | 本地 PostgreSQL 容器 | 密码规则                          |
| ---------- | ------------------------------------------------------------------------- | -------------------- | --------------------------------- |
| `bundled`  | `POSTGRES_USER`、`POSTGRES_DB`、`POSTGRES_PASSWORD`、`QM_POSTGRES_VOLUME` | 启动                 | `POSTGRES_PASSWORD` 至少 8 个字符 |
| `external` | 完整的 `DATABASE_URL`                                                     | 不启动               | 不检查供应商密码长度或格式        |

`bundled` 是兼容已有部署的默认值。应用会对用户名和密码进行百分号编码，因此密码不需要是
十六进制，也可以包含 `@`、`:`、`/`、`?`、`#`、`%` 等字符。包含 `$`、`#` 或空白的原始密码
必须按 Compose env-file 语法加引号，例如 `POSTGRES_PASSWORD='p$word#1@'`。`POSTGRES_DB`
只允许字母、数字、点、下划线和连字符。已有数据卷中角色的实际密码不会因修改环境文件而自动改变；
复用数据卷时必须让环境值与数据库角色保持一致。
该模式下 `DATABASE_URL` 必须为空，避免声明使用内置库但实际绕过到外部地址。

`external` 直接使用供应商提供的连接串，例如：

```dotenv
QM_DATABASE_MODE=external
QM_DATABASE_TRANSPORT=tls
DATABASE_URL=postgresql://qm:p%40ssword@db.internal.example.net:5432/qm?sslmode=require
```

应使用供应商给出的完整连接串；其中用户名或密码包含保留字符时必须进行百分号编码。连接串只保存在权限为 `0600`
的 `.env.production` 或受控密钥系统中，不能写入 Git、工单、聊天或命令输出。

外部模式必须显式设置传输契约：要求数据库会话使用 TLS 时设置
`QM_DATABASE_TRANSPORT=tls`，预检会通过 `pg_stat_ssl` 检查实际会话；数据库链路完全位于私网、VPN
或隧道内时才可设置 `QM_DATABASE_TRANSPORT=private-network`。

## 外部数据库能力要求

外部数据库必须满足以下条件：

- 使用直连或会话级连接池，不能使用事务级连接池。
- 支持同一会话内获取和释放 PostgreSQL advisory lock。
- 支持 `LISTEN` 和 `NOTIFY`。
- 运行账户可以创建和修改 QM 表、约束和索引，并可创建和维护 pg-boss 使用的 schema。
- 按供应商要求启用 TLS，并通过私网、VPN 或隧道连接。
- 连接数、语句超时、空闲事务超时和备份保留策略满足生产容量要求。

生产预检会对最终连接串重试连接，执行查询，使用随机键验证会话级 advisory lock 的获取与释放，并
验证 `LISTEN`/`UNLISTEN`。失败信息不会包含连接串或
供应商密码；详细原因应在数据库供应商的审计日志和监控中查看。

## 迁移与回滚

在 `bundled` 和 `external` 之间切换会改变持久数据目标，必须按数据库迁移处理，不能当作普通环境变量
修改。

1. 对源数据库执行逻辑备份并完成恢复演练，同时备份 `core-data` 和全部 `qm-home-*` 卷。
2. 确认目标 PostgreSQL 版本、扩展、权限、TLS、连接池模式和容量满足要求。
3. 先运行 `./scripts/deploy-production-release.sh .env.production prepare`，确认目标 release 和镜像完整。
4. 安排停机窗口，停止所有仍向源数据库写入的旧 core，再执行最终一致性 dump 并恢复到目标数据库。
5. 在 `.env.production` 中切换 `QM_DATABASE_MODE`，并同步目标连接配置后执行 `apply`。
6. 验收数据库、浏览器登录、管理员权限、真实 Agent 对话、沙箱、模型和连接器。

外部模式的新栈通过 `--wait` 后，部署脚本会停止并移除旧的内置 PostgreSQL 容器，但不会删除其数据卷。
如果外部模式启动失败，脚本不会执行这一步，旧数据卷和旧数据库容器仍可用于受控回滚。

回滚必须恢复与旧版本匹配的数据库及卷备份。停止或迁移过程中禁止运行
`docker compose down -v`，否则会删除 Compose 管理的持久卷。
