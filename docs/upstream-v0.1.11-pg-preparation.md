# v0.1.11 集成前的 PostgreSQL 兼容准备

本批是 [二开验收清单](./upstream-v0.1.11-acceptance.md) S2 的数据库前置工作，尚未执行上游 merge，也不签收完整 DB-01～DB-06。先建立可独立验证的下游迁移契约，再合并上游 registry、连接池及其消费者，避免在大量冲突中丢失旧库兼容约束。

## 固定范围

- 下游及实际生产版本：`xingstudy/yc-qm` 的 `prod-v1.3.0`，提交 `bd1cb20411a69ff7badd95da4d482961b07d4b7b`。
- 上游目标：`v0.1.11`，提交 `51bf455ea414a58f70274284ce212142518e556a`。
- 独立工作树：`codex/sync-upstream-v0.1.11`。原工作树及 main 不参与本批修改。
- 验证环境：Linux Node 24.18.0、npm 11.16.0，独立 PostgreSQL 18 容器与专用测试库；没有读取生产数据库或调用真实模型、企业微信发送接口。

## 实现与不可丢失的合并决策

| 部分         | 本批行为                                                                                                                        | 后续合并约束                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 首次迁移     | 组织、目录来源、成员 job、Portal 登录四个下游存储使用固定命名迁移；`PROD_V1_3_0_SCHEMA` 和硬编码 checksum 固定首次定义          | 新 DDL 必须追加到 `MIGRATIONS`，使用新显式 ID。不能编辑首次数组、重排分组、更新旧 checksum 来让启动通过 |
| 独立账本     | `qm_schema_migrations` 存储 ID、checksum、应用时间；旧表没有账本时执行幂等收敛 DDL 后记账                                       | 仅在旧 `schema_migrations` 确实有指定 legacy ID 时 adopt；四个下游 bootstrap 没有伪造 legacy ID         |
| 事务边界     | 普通 DDL 和该迁移的账本插入在同一事务；后续迁移失败保留已经完成的迁移，重试跳过它们                                             | “失败不记成功”针对失败的单个迁移，不能把多迁移整体描述为一个原子事务；初始化失败的 pool 不返回给调用者  |
| 并发索引     | `transactional:false` 只允许一个带 `IF NOT EXISTS` 的 `CREATE INDEX CONCURRENTLY`；修复 invalid/not-ready 残留索引后重试        | 不能直接采用上游对所有迁移统一 BEGIN 的实现。索引成功但尚未记账时，可幂等补记                           |
| 每次启动维护 | 保留组织归属检查、旧 skill/ACL 数据归属补齐、closure 检查、legacy runtime eligibility 与 identity projection 的内部 marker 语义 | 这些操作不进入永久跳过的首次迁移账本；错租户及坏派生状态必须阻止该存储初始化                            |
| 初始化锁     | 顺序获取 `qm:schema-migrations`、`agent-platform:schema-init`，反序释放；try-lock 共用最多 5 分钟等待预算                       | 同时协调旧下游与新迁移协议；查询读超时也受剩余等待时间约束。此预算不代表所有 DDL 的总执行超时           |
| 故障清理     | 操作失败、解锁异常或返回 false 时丢弃 client；release 自身异常时调用 client.end，并保留原始与清理错误                           | 丢弃/关闭路径有注入测试；实际进程中断和 DB 断开恢复仍需后续故障演练                                     |
| 过渡接口     | 其他存储暂时仍可使用旧 SQL 数组；目录来源的长会话锁调用 `sessionPool()`，当前返回原来的直连 pool                                | 这不是事务池支持。完成上游 merge 时再清零旧调用、引入全局注册迁移顺序及真正的 query/session 池分离      |

实现入口：[pg-schema-migrations](../src/persistence/pg-schema-migrations.ts)、[pg-pool](../src/persistence/pg-pool.ts)、[迁移回归测试](../test/pg-schema-migrations.test.ts)。

## fixture 的来源与证据边界

[固定 fixture](../test/fixtures/postgres/prod-v1.3.0-schema.json) 通过 `git show prod-v1.3.0:<文件路径>` 读取四个下游存储，由 TypeScript AST 提取原始 schema 字符串数组。文件记录源提交、源文件路径、建表语句，以及固定的 16 条预期迁移 ID/checksum。运行测试时不依赖 Git 历史，浅克隆 CI 也可复现。

预期账本是固定数据，测试不能调用生产分组/编号算法重新生成期望值。修改算法后如导致迁移 ID 变化，测试必须失败；fixture 和旧 checksum 不能随业务迁移一起刷新。组织的首次定义按普通事务与并发索引边界固定为 13 个迁移，其余三个存储各一个。

组合测试用旧语句建立 schema 后插入纯合成数据，比较以下八张表的完整 JSON 行内容：组织用户、认证身份、目录来源、目录密文、成员 job、成员 job item、登录 transaction、登录 rate limit。覆盖 paused 用户、session/profile revision、来源 secret revision fence、任务 JSON、登录 payload。随后初始化候选、重新执行旧版建表语句、再初始化候选，核对数据与固定账本；另测错租户启动失败、追加独立新迁移不改变旧账本。

组合测试显式关闭目录与成员 job 存储；组织和 Portal 的现有公共接口没有 close，其空闲连接沿用 node-postgres 默认 10 秒 idle timeout 回收。本批未为了测试扩大这两个生产接口。

这里的密文是不会解密的合成字符串，只证明字节保留，不能证明生产旧密文可读。这里的旧版语句重放也不能替代旧镜像回滚、全服务启动或实际生产副本演练。

## 已执行检查

| 检查                                                                     | 结果                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| 修改前，四个下游存储与 persistence-init-retry 的专用 PG 基线             | 58 通过、0 失败、0 跳过                                                         |
| 候选迁移、四个存储及初始化重试                                           | 70 通过、0 失败、0 跳过；清理路径修订后新增迁移 12/12，追加关闭断言单项 1/1     |
| pg-pool、CA 信任、URL、独立维护入口、durable map、advisory lock 消费者   | 37 通过、0 失败、0 跳过                                                         |
| 根 TypeScript 项目、改动 TS 的 ESLint/Oxlint、格式检查、Knip             | 全部通过；Knip 初次因新工作树缺 Web UI 依赖失败，复用相同锁文件的本地依赖后通过 |
| 上游完整 merge、全量 CI、dev-instance、真实模型/企业微信、生产升级或回滚 | 未执行                                                                          |

新增迁移测试区分真实 PostgreSQL 和注入测试：建表/升级、事务回滚、invalid 索引恢复、新旧锁等待、两个独立 OS 进程正常并发均使用真实数据库；unlock false/error、release 异常和 rollback 异常使用注入 client，不能写成真实网络故障或 SIGKILL 证据。

`npm run test:pg` 已加入新迁移测试及原先未列入的成员 job PG 测试，避免完整 CI 只执行无 DATABASE_URL 的跳过分支。本地只跑影响范围，完整 CI 留到集成 PR。

在专用测试库复跑候选核心检查：

```bash
node --experimental-test-module-mocks --test --test-concurrency=1 \
  test/pg-schema-migrations.test.ts \
  test/postgres-organization-store.test.ts \
  test/postgres-directory-source-store.test.ts \
  test/postgres-member-job-store.test.ts \
  test/postgres-portal-login-transactions.test.ts \
  test/persistence-init-retry.test.ts
```

运行前需设置专用 `DATABASE_URL`。这些存储测试会删除其测试表和对应迁移记录，不能用于生产连接。

## 独立审查与尚未签收项

独立审查代理 `review_pg_acceptance` 未编写本批代码，对四个存储的启动维护语义、迁移边界和验收证据逐项检查。修订后复审确认无本前置提交的新增阻断代码问题；该结论不批准完整上游集成或部署。

| 发现                                                                                  | 处理                                                                                                           |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 从可变 schema 数组生成首次迁移，后续追加 DDL 会改变已记录 checksum                    | 冻结首次数组与 checksum；暴露独立 `MIGRATIONS` 列表追加新 ID；增加旧账本继续升级回归                           |
| 测试与生产共用分组算法生成预期账本，可能同时漂移而变绿                                | fixture 固定 ID/checksum，测试直接比较固定数据                                                                 |
| release 异常原先只上抛，未证明尝试关闭不安全 session                                  | 增加 client.end 兜底及关闭调用断言；不把注入测试描述为真实连接故障                                             |
| 旧版启动会重写 CREATE OR REPLACE FUNCTION/trigger，新账本却可能跳过后续版本的相同修复 | 当前固定源语句重放纳入组合测试；未来修改函数/trigger 必须设计 repair migration 或按启动维护，并纳入 DB-06 矩阵 |

继续保持以下阻断项，不因本批测试通过而签收：

1. **DB-01 / GAP-03**：合并后全仓扫描 `createPgPool/schema/pool/new pg.Pool/锁/LISTEN`，迁移所有旧签名；验证完整 store 注册先于 `migrateRegisteredPgSchemas`，迁移失败前不接流量。
2. **DB-02 / GAP-08**：实际支持版本的旧库副本、旧 IM/Bot 密文解密、会话/审计/绑定等全表与全服务组合验证。用户已确认生产 tag 与专用企业微信/模型测试资源具备；本批未访问这些资源。
3. **DB-03 / GAP-15**：事务 DDL/账本边界、CONCURRENTLY 不同阶段的真实 SIGKILL，以及数据库中断后同一 wrapper 恢复。正常双进程并发与 SQL 错误重试不能替代这些场景。
4. **DB-04**：实际事务池与独立 sessionPool 的身份、CA、通知、leader 和会话锁验证。
5. **DB-05**：目录/成员 job、cron、IM 三类业务 claim 与外部副作用中断分别验证；本批 schema 锁测试不作为业务幂等证据。
6. **DB-06**：旧读者与新 schema、函数/trigger 反复升降级、实际写冻结与备份恢复、delta 和时间预算。未证明可以直接换回旧镜像。

本批只建立前置兼容提交。下一步仍是固定 `v0.1.11` 的实际 merge、逐模块冲突决策与无冲突消费者适配，之后进入整栈验收和 CI。
