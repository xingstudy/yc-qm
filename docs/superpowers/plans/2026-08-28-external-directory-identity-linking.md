# 外部目录身份匹配与登录绑定开发计划

**实施状态：** 第一阶段已于 2026-08-29 完成，本文保留原始任务拆分作为实现与验收追踪依据。

**目标：** 按 [`external-directory-identity-linking-prd.md`](../../external-directory-identity-linking-prd.md) 建立通用的组织级身份来源、外部成员同步、匹配、绑定和登录解析能力，首个 provider 落地企业微信，并保证企业微信扫码登录进入已有 QM 组织成员而不是创建重复账号。

**架构：** Core 是身份来源配置、加密凭据、provider 调用、同步快照、匹配和 canonical `principalId` 解析的唯一真相。Auth 插件只负责浏览器登录协议、跳转和 OIDC token 签发，通过 `plugins/chassis` 的签名 Core client 获取登录选项并兑换平台 code，不读取数据库密钥。Portal 只验证 OIDC token、转发标准化外部身份断言并建立 Core 返回的 canonical 会话。Admin 插件只做精确路径代理和 UI。

**首期范围：** 企业微信 `CorpID + UserID` 稳定身份、`biz_mail` 首次自动匹配、管理员配置和匹配工作台、周期同步、目标成员刷新、手工绑定和纠正绑定。不同来源可以绑定同一 QM 成员；同步不创建组织成员，不覆盖组织资料、部门、访问组、权限或成员状态。

**技术栈：** TypeScript、Node.js ≥24、`node:test`、PostgreSQL、vanilla JavaScript Admin SPA。优先复用现有 `DurableMap`、PostgreSQL store、`createSweeper`、`LeaderLease`、chassis 签名 client 和 secret box，不新增 npm 依赖。

## 全局约束

- 当前 checkout 是私有 fork，所有 PR 只面向 `xingstudy/yc-qm`；使用 `gh` 时始终显式传 `--repo xingstudy/yc-qm`，不创建或建议上游 PR。
- 修改前以当前工作区为准，保留所有无关未提交改动。
- 不在插件中导入 Core；plugin↔core 协议和 client 放在 `plugins/chassis`，chassis 不导入 Core。
- Core 解密身份来源 secret 并调用 provider；Auth、Portal、Admin 和浏览器永远拿不到 provider secret。
- `organization_users` 继续作为组织成员主数据，现有全局 `DirectoryStore.replace()` 不接收外部身份来源快照。
- provider 专属字段只存在于 provider adapter 和 provider 配置 schema。通用匹配服务不得出现企业微信、Slack、飞书或钉钉分支。
- 稳定绑定依据是 source、外部租户和外部成员 ID；邮箱、员工编号、手机号、姓名和部门不能成为永久身份主键。
- 受管来源匹配失败必须 fail closed，不得回退到 `domain_auto_join`。
- 第一阶段同步不创建、更新、暂停或离职 `organization_users`，也不修改组织节点和授权关系。
- 生产同步配置、成员快照、游标、租约、运行结果、忽略决定和身份绑定全部持久化；没有 PostgreSQL 时管理和同步接口返回 `503 not_configured`。
- Secret、access token、完整手机号、完整员工编号和 provider 原始响应不得进入日志、审计正文、指标标签或错误堆栈。
- 身份绑定、纠正绑定、会话版本变化和审计必须在同一数据库事务中完成。
- 每个任务先写受影响测试，再实现，再运行对应测试。
- 代码不得新增注释、docblock、TODO、lint/type suppression 或注释掉的代码。
- 每个 PR 独立通过受影响测试、typecheck、lint 和 format check。
- 每个 PR 合并前由未参与实现的 fresh-context reviewer 审查。认证、凭据、事务、并发同步和绑定纠正至少安排两个不同审查视角。

## 推荐 PR 划分

1. **PR A：通用身份来源契约与持久化**
   - Tasks 1–3：领域类型、store、PostgreSQL schema、加密凭据和 wiring。
   - 不新增管理入口，不改变登录行为。
2. **PR B：来源配置 API 与 Admin 页面**
   - Tasks 4–6：provider registry、企业微信连接测试、Core 管理 API、Admin 配置 UI。
   - 只允许配置和连接测试，不启动周期同步，不改变登录行为。
3. **PR C：持久化同步引擎与企业微信成员快照**
   - Tasks 7–8：同步调度、预览、完整同步、目标刷新和企业微信 adapter。
   - 仅生成来源快照和差异，不写身份绑定，不改变登录行为。
4. **PR D：通用匹配、绑定服务与匹配工作台**
   - Tasks 9–11：匹配规则、自动/手工绑定、忽略、纠正绑定和 Admin 工作台。
   - 自动绑定只在 dry-run 或管理员显式执行时使用，真实扫码登录尚不切换。
5. **PR E：稳定外部身份登录链路**
   - Tasks 12–13：Auth↔Core 协议、稳定 OIDC claims、Portal 转发、Core 登录解析和受管来源 gate。
   - 这是唯一改变真实登录行为的 PR，必须在 PR A–D 已部署可用后合并。
6. **PR F：兼容迁移、可观测性和端到端交付**
   - Tasks 14–16：`.env` 兼容、现有身份对账、部署配置、指标、文档、Firefox live QA 和审查。

依赖顺序：

```text
PR A → PR B → PR C → PR D → PR E → PR F
                    ↘ dry-run 验证 ↗
```

不得把 PR E 提前合并，也不得用隐藏 UI 作为未完成冲突处理和安全边界的替代。

## 第一阶段：通用契约与持久化

### Task 1：冻结领域契约和 plugin↔core 边界

**文件：**

- 新建：`src/directory-sources/types.ts`
- 新建：`src/directory-sources/provider.ts`
- 新建：`test/directory-source-contract.test.ts`
- 后续修改：`plugins/chassis/src/directory-source-client.ts`

**步骤：**

- [ ] 定义 `DirectorySourceProvider`、provider capability、来源状态、登录/同步独立开关和 match policy。
- [ ] 定义公开来源配置与含 secret 的内部配置，确保公开类型不包含 secret、密文或 token。
- [ ] 定义规范化外部成员：租户 ID、成员 ID、姓名、分类邮箱、员工编号、手机号、部门引用、外部状态、revision 和观察时间。
- [ ] 定义同步运行类型：`preview | scheduled | manual | targeted` 和 `queued | running | succeeded | failed | expired`。
- [ ] 定义标准化登录断言，明确浏览器不能直接构造可信标记。
- [ ] 定义匹配状态和结果类型：`bound | suggested | unmatched | conflict | ignored | inactive`。
- [ ] 定义 provider adapter 接口：`capabilities`, `testConnection`, `fullSync`, `targetedLookup`；不为只有一个调用者的字段制造额外抽象。
- [ ] 写契约测试，验证 provider 专属输入经过 adapter 后只能输出通用模型，未知 capability 和非法状态被拒绝。
- [ ] 使用 `rg` 扫描现有 WeCom、Slack、飞书和钉钉身份字段，列出所有需要收口到 adapter 的位置。

**完成条件：** 后续 store、API、UI、Auth 和 Portal 都引用同一组 Core 领域语义；插件只通过 chassis 的 JSON 协议共享必要字段。

### Task 2：实现来源、成员和同步运行 store

**文件：**

- 新建：`src/directory-sources/directory-source-store.ts`
- 新建：`src/directory-sources/postgres-directory-source-store.ts`
- 新建：`test/directory-source-store.test.ts`
- 新建：`test/postgres-directory-source-store.test.ts`
- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`test/organization-store.test.ts`
- 修改：`test/postgres-organization-store.test.ts`

**Schema：**

- `directory_sources`
  - 组织、source ID、provider、名称、外部租户 ID、状态、两个 capability 开关、周期、match policy、capabilities、revision 和审计时间字段。
- `directory_source_secrets`
  - 组织、source ID、purpose、密文、版本和更新时间；不保存明文。
- `directory_source_members`
  - source 专属外部成员快照、规范化字段、profile hash、外部状态、match state 和观察时间。
- `directory_sync_runs`
  - durable job、cursor、lease、计数、清洗后的错误、幂等键和生命周期时间。
- `auth_identities`
  - 增加 nullable `source_id`, `external_subject_id`, `matched_by` 和最小 evidence metadata，使现有表演进为外部登录绑定真相，不新增第二张独立决定 canonical 用户的绑定表。

**约束：**

- `(org_id, provider, external_tenant_id)` 对未删除来源唯一。
- `(org_id, source_id, external_subject_id)` 对来源成员和来源身份唯一。
- 第一阶段 `(org_id, source_id, principal_id)` 对 source-backed `auth_identities` 唯一。
- 来源身份继续使用 `(org_id, principal_id)` 外键指向 `organization_users`。
- 同一来源只有一个 running sync；幂等键不能重复创建运行。

**步骤：**

- [ ] memory store 实现仅供单元测试，行为与 PostgreSQL 一致。
- [ ] PostgreSQL 使用 expand schema，保留现有非来源 OIDC identity 数据。
- [ ] 来源列表、详情和成员分页全部按 `org_id` 隔离。
- [ ] 完整快照使用 staging/事务语义；只有成功完成的批次才能把缺失旧成员标记 inactive。
- [ ] 分页或 provider 调用失败时不提交 inactive 推断。
- [ ] 同步 run claim、续租、成功和失败更新使用 CAS 或行锁。
- [ ] 为老 schema 升级、唯一约束、跨组织拒绝、多实例 claim、幂等重放和进程重启持久化写 PostgreSQL 测试。
- [ ] 验证 source 快照不会写入 `directory_members` 或触发现有 Slack directory replacement。

**运行：**

```bash
node --experimental-test-module-mocks --test \
  test/directory-source-contract.test.ts \
  test/directory-source-store.test.ts \
  test/organization-store.test.ts
node --test --test-concurrency=1 \
  test/postgres-directory-source-store.test.ts \
  test/postgres-organization-store.test.ts
```

### Task 3：实现加密来源配置 service 和 wiring

**文件：**

- 新建：`src/directory-sources/directory-source-service.ts`
- 新建：`test/directory-source-service.test.ts`
- 修改：`src/connectors/connector-client-store.ts`
- 修改：`src/wiring.ts`
- 修改：`src/api/routes/route.ts` 或对应 `ServerDeps` 定义
- 修改：`test/support/test-config.ts`

**步骤：**

- [ ] 复用 `deriveConnectorKey`, `encryptSecret`, `decryptSecret`，使用独立 purpose `directory-source-secrets`。
- [ ] 实现来源创建、更新、暂停、软删除、公开投影和 secret 轮换。
- [ ] 创建时只保存已通过 provider 连接测试的租户 ID；启用后不能普通 PATCH 更换租户。
- [ ] 登录和同步开关独立，更新使用 `expectedRevision`。
- [ ] 软删除保留成员快照、绑定和审计，公开列表默认隐藏已删除来源。
- [ ] secret getter 只暴露给 provider runtime，不进入 route 返回对象。
- [ ] PostgreSQL 缺失时生产 service 不可用，管理和同步 route 后续返回 `503`；不得使用随机进程密钥制造不可解密持久化数据。
- [ ] 将 store/service 接入 `buildApp`, `BuiltApp`, `serverDeps` 和 shutdown 生命周期。
- [ ] 测试 secret round-trip、错误 key、公开投影、CAS、软删除、暂停和跨组织隔离。

## 第二阶段：来源配置 API 与 Admin

### Task 4：实现 provider registry 和企业微信连接测试

**文件：**

- 新建：`src/directory-sources/provider-registry.ts`
- 新建：`src/directory-sources/providers/wecom.ts`
- 新建：`test/wecom-directory-provider.test.ts`
- 修改：`src/wiring.ts`

**步骤：**

- [ ] registry 根据 provider ID 返回 adapter 和 capability，不把 provider 分支散落在 service、route 或 UI。
- [ ] 企业微信公开配置包含 CorpID、AgentID 和回调配置；secret 只存在加密内部配置。
- [ ] `testConnection` 使用短超时调用企业微信服务端 API，验证 CorpID、secret 和应用可用性。
- [ ] 验证返回租户与输入 CorpID 一致，AgentID 属于同一企业并且应用具备所需成员可见范围。
- [ ] 所有 URL 固定为 adapter 内批准的企业微信 host，拒绝配置自定义 API base URL，测试注入使用 `fetchImpl`。
- [ ] 将 provider error 映射为稳定错误码和清洗后的管理员提示，不记录 access token 或完整 provider payload。
- [ ] 为超时、非 JSON、HTTP 错误、企业微信 `errcode`、缺字段和租户不一致写测试。
- [ ] 在实现前核对企业微信官方当前 API 和权限要求；测试 fixture 固定必要字段，避免依赖实时文档响应。

### Task 5：新增 Core 身份来源管理 API

**文件：**

- 新建：`src/api/routes/admin/directory-sources.ts`
- 修改：`src/api/routes/admin.ts`
- 修改：`src/api/routes/index.ts` 或实际 route registry
- 新建：`test/directory-source-routes.test.ts`
- 修改：`test/route-auth-conformance.test.ts`

**接口：**

```text
GET    /v1/admin/org/directory-sources/catalog
GET    /v1/admin/org/directory-sources
POST   /v1/admin/org/directory-sources
GET    /v1/admin/org/directory-sources/:sourceId
PATCH  /v1/admin/org/directory-sources/:sourceId
DELETE /v1/admin/org/directory-sources/:sourceId
POST   /v1/admin/org/directory-sources/:sourceId/test
```

**步骤：**

- [ ] 只允许 Portal 组织管理员，拒绝 source-only、agent capability、manager 和普通成员。
- [ ] catalog 返回 capability、所需公开字段、secret 字段名称和 UI 提示，不返回实现函数。
- [ ] 创建/更新请求限制 Content-Type、body 大小、字段长度、周期范围和未知字段。
- [ ] secret 使用 write-only 语义；省略表示保留，显式轮换必须重新连接测试。
- [ ] 删除先返回影响摘要或要求明确确认 revision，执行软删除。
- [ ] 来源写入和审计同成同败；secret 不进入审计 detail。
- [ ] 对 `409` revision 冲突、`400` provider 校验、`403` 权限、`503` durable store 缺失写路由测试。
- [ ] 为每条新增 route 更新 auth conformance 测试。

### Task 6：实现 Admin 身份来源配置页面

**文件：**

- 修改：`plugins/admin/src/index.ts`
- 修改：`plugins/admin/public/index.html`
- 新建：`plugins/admin/test/directory-sources.test.ts`
- 修改：`plugins/admin/test/i18n.test.ts`
- 修改：`plugins/admin/test/default-view.test.ts` 或导航结构测试

**步骤：**

- [ ] Admin 插件只代理 Task 5 的精确路径，不新增 `/directory-sources/*` 宽泛写通配。
- [ ] 在组织管理导航增加“身份来源”，仅组织管理员显示。
- [ ] 实现来源卡片：provider、租户、状态、登录开关、同步开关、最近测试和配置来源。
- [ ] 实现新增向导：选择 provider、填写配置、展示回调地址、连接测试、确认租户、保存。
- [ ] 实现编辑、secret 轮换、暂停、重新启用和软删除影响确认。
- [ ] 页面明确说明当前只配置身份来源，不创建成员、不覆盖资料、不修改组织架构。
- [ ] secret 输入保存后立即清空，浏览器不缓存或回填；页面只展示 `hasSecret`。
- [ ] 正确处理 loading、空状态、连接测试失败、`409` revision 冲突和 `503` 未配置。
- [ ] 补齐中英文文案和 Admin 页面结构测试。
- [ ] 使用真实感数据准备来源列表、创建向导和删除确认截图，随 PR B 提交。

## 第三阶段：同步引擎与企业微信快照

### Task 7：实现 durable 同步引擎和调度

**文件：**

- 新建：`src/directory-sources/directory-sync-engine.ts`
- 新建：`test/directory-sync-engine.test.ts`
- 修改：`src/wiring.ts`
- 修改：`src/index.ts`
- 修改：`src/util/sweeper.ts`，仅当现有接口确实缺少所需能力

**步骤：**

- [ ] 支持 `preview | scheduled | manual | targeted` 四种运行类型。
- [ ] 使用 `createSweeper` 扫描到期来源，使用现有 `LeaderLease` 或数据库 run claim 保证多实例单执行。
- [ ] 默认周期 6 小时，配置范围 15 分钟至 24 小时。
- [ ] preview 生成计数和差异但不提交成员快照、不写绑定。
- [ ] manual 和 scheduled 完整同步先写 staging，全部分页成功后原子提交。
- [ ] targeted 只 upsert 一个外部成员，不对其他成员做 inactive 推断。
- [ ] 同一来源并发请求合并或返回现有 running run，不创建第二个执行。
- [ ] run 状态、cursor、lease、错误和计数每一步持久化，重启后过期 lease 可恢复。
- [ ] 关闭同步开关立即阻止新 scheduled run，但不粗暴中断已进入提交事务的运行。
- [ ] shutdown 停止调度并释放可释放资源；不能把运行中任务错误标为成功。
- [ ] 为多实例竞争、lease 过期、分页失败、幂等重放、暂停和 targeted 并发写测试。

### Task 8：完成企业微信完整同步、目标刷新和同步 API

**文件：**

- 修改：`src/directory-sources/providers/wecom.ts`
- 修改：`test/wecom-directory-provider.test.ts`
- 修改：`src/api/routes/admin/directory-sources.ts`
- 修改：`test/directory-source-routes.test.ts`
- 修改：`plugins/admin/src/index.ts`
- 修改：`plugins/admin/public/index.html`
- 修改：`plugins/admin/test/directory-sources.test.ts`

**接口：**

```text
POST /v1/admin/org/directory-sources/:sourceId/sync-preview
POST /v1/admin/org/directory-sources/:sourceId/sync
GET  /v1/admin/org/directory-sources/:sourceId/runs
GET  /v1/admin/org/directory-sources/:sourceId/runs/:runId
```

**步骤：**

- [ ] 按企业微信官方接口分页获取可见成员稳定 UserID，再读取匹配所需资料。
- [ ] 将 `biz_mail` 标准化为 `corporate` 邮箱，将个人 `email` 标准化为 `personal`，不得交换优先级。
- [ ] 输出 `CorpID + UserID`、成员状态、姓名、分类邮箱、员工编号、手机号和部门引用。
- [ ] 限制 provider 并发和单次同步规模，使用现有 async helper，不创建无界 Promise 集合。
- [ ] token 缓存只作为可丢弃缓存，secret 和同步事实仍在 durable store。
- [ ] targeted lookup 按 UserID 查询单个成员，结果同 full sync 使用完全相同的 normalization。
- [ ] 完整同步中途失败保留旧成功快照；只有完整成功才标记缺失成员 inactive。
- [ ] Admin 来源详情增加立即同步、预览、最近运行、计数、数据新鲜度和错误摘要。
- [ ] 明确验证同步后 `organization_users`、`org_unit_members`、`access_group_members` 和 `directory_members` 均未变化。

**运行：**

```bash
node --experimental-test-module-mocks --test \
  test/directory-sync-engine.test.ts \
  test/wecom-directory-provider.test.ts \
  test/directory-source-routes.test.ts
node --test --test-concurrency=1 test/postgres-directory-source-store.test.ts
NODE_ENV=test ALLOW_UNSIGNED_TEST_IDENTITY=1 node --test \
  plugins/admin/test/directory-sources.test.ts \
  plugins/admin/test/i18n.test.ts
```

## 第四阶段：匹配、绑定与管理员工作台

### Task 9：实现通用匹配引擎

**文件：**

- 新建：`src/directory-sources/identity-match.ts`
- 新建：`test/directory-identity-match.test.ts`
- 修改：`src/directory-sources/directory-source-service.ts`

**步骤：**

- [ ] 匹配顺序固定为：已有稳定绑定、唯一可信企业邮箱、唯一员工编号建议、唯一手机号建议、姓名/部门辅助展示。
- [ ] 第一阶段只有 `verified_corporate_email` 或 `manual_only` 两种策略，不增加每字段开关。
- [ ] 员工编号、手机号、姓名和部门不能返回 automatic 决策。
- [ ] 多候选、同来源已绑定、邮箱与员工编号指向不同成员、deprovisioned 目标和唯一约束冲突返回 `conflict`。
- [ ] suspended 现有绑定保持，新的自动绑定不激活或恢复该成员。
- [ ] 不同 source 已绑定同一 `principalId` 不构成冲突。
- [ ] 返回稳定的 reason code 和最小 evidence summary，UI 文案不解析自由文本。
- [ ] 使用表驱动测试覆盖大小写邮箱、个人邮箱、重复邮箱、空字段、冲突证据、其他来源绑定、同来源绑定和 inactive 外部成员。
- [ ] matcher 保持纯函数或无写副作用；绑定事务由 Task 10 负责。

### Task 10：实现绑定、忽略和纠正绑定 service/API

**文件：**

- 新建：`src/directory-sources/identity-linking-service.ts`
- 新建：`test/directory-identity-linking.test.ts`
- 修改：`src/directory-sources/directory-source-store.ts`
- 修改：`src/directory-sources/postgres-directory-source-store.ts`
- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`src/api/routes/admin/directory-sources.ts`
- 修改：`test/directory-source-routes.test.ts`
- 修改：`test/postgres-directory-source-store.test.ts`

**接口：**

```text
GET    /v1/admin/org/directory-sources/:sourceId/members
GET    /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId
POST   /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/bind
POST   /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/ignore
DELETE /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/ignore
POST   /v1/admin/org/directory-sources/:sourceId/members/:externalSubjectId/rebind
```

**步骤：**

- [ ] 成员列表服务端执行状态、搜索、最近登录尝试和游标分页。
- [ ] 自动绑定、手工绑定和 rebind 在事务内重新读取 source member、配置 revision、目标用户和现有 identities。
- [ ] source-backed identity 写入现有 `auth_identities`，包括稳定 OIDC issuer/subject、source ID、外部成员 ID 和 matched-by。
- [ ] 允许目标用户拥有其他 source 的 identity；拒绝同一 source 第二个外部 identity。
- [ ] 拒绝新绑定到 deprovisioned 用户；suspended 用户不因绑定变 active。
- [ ] ignore 持久化管理员和原因；强字段变化或登录尝试自动取消 ignore。
- [ ] rebind 使用专用高风险事务，验证新目标、移动 identity、递增旧/新目标 session version 并写审计。
- [ ] rebind 不移动文件、项目、会话历史、Skill、Cron 或其他用户资源。
- [ ] 自动绑定、手工绑定、ignore、取消 ignore、rebind 和拒绝结果都写可解释审计，detail 不含完整敏感字段。
- [ ] PostgreSQL 测试并发双绑、同来源唯一约束、跨组织、事务回滚、session version 和审计同成同败。

### Task 11：实现 Admin 匹配工作台和成员详情集成

**文件：**

- 修改：`plugins/admin/src/index.ts`
- 修改：`plugins/admin/public/index.html`
- 修改：`plugins/admin/test/directory-sources.test.ts`
- 修改：`plugins/admin/test/org-users.test.ts`
- 修改：`plugins/admin/test/i18n.test.ts`

**步骤：**

- [ ] 精确代理 Task 10 路径，普通成员和 manager 在 Admin 插件层及 Core 层均被拒绝。
- [ ] 来源详情增加 `bound | suggested | unmatched | conflict | ignored | inactive` 统计和筛选。
- [ ] 实现外部成员列表、服务端搜索、分页、匹配依据和最后同步/登录尝试时间。
- [ ] 详情抽屉并排展示外部资料、候选 QM 成员资料和现有身份；手机号默认掩码。
- [ ] 实现手工绑定、ignore、取消 ignore 和 rebind 影响确认。
- [ ] rebind 确认明确说明旧会话失效且不合并历史资源。
- [ ] 在现有组织成员详情增加只读来源身份列表和跳转入口。
- [ ] 正确处理候选在操作前变化、`409` revision、唯一冲突、用户已离职和 source 已暂停。
- [ ] PR D 附来源统计、冲突详情、绑定确认和 rebind 确认的真实感截图。

## 第五阶段：稳定外部身份登录链路

### Task 12：建立 Auth↔Core 身份来源登录协议

**文件：**

- 新建：`plugins/chassis/src/directory-source-client.ts`
- 新建：`plugins/chassis/test/directory-source-client.test.ts` 或对应 chassis 测试位置
- 修改：`src/api/routes/auth-broker.ts`
- 修改：`test/auth-broker-claim.test.ts`
- 修改：`plugins/auth/src/index.ts`
- 修改：`plugins/auth/src/server.ts`
- 修改：`plugins/auth/src/config.ts`
- 修改：`plugins/auth/src/tokens.ts`
- 修改：`plugins/auth/src/pages.ts`
- 修改：`plugins/auth/test/flow.test.ts`
- 修改：`plugins/auth/test/config.test.ts`
- 修改：`plugins/auth/README.md`

**Core 内部接口：**

```text
GET  /v1/auth/directory-sources/login-options
POST /v1/auth/directory-sources/:sourceId/resolve-code
```

**步骤：**

- [ ] 两条接口只接受 chassis source-auth，增加 nonce/replay 防护和输入大小限制。
- [ ] login options 只返回 source ID、显示名、provider、构造授权跳转所需公开字段和登录状态。
- [ ] Auth 插件把 source ID 封入现有加密/签名 state，callback 不接受浏览器任意替换 source。
- [ ] resolve-code 由 Core 解密 source secret、调用企业微信并返回规范化外部身份；Auth 插件从不接收 secret。
- [ ] Core 校验 source enabled、login enabled、provider、租户、redirect URI 和 code 时效。
- [ ] 一个组织存在多个登录来源时页面逐项展示；provider 不支持多来源时在服务端明确拒绝冲突配置。
- [ ] 扩展 Auth code/access token 和 OIDC claims，携带 source、provider、外部租户和外部成员 ID。
- [ ] 企业微信 OIDC `sub` 基于稳定 `CorpID + UserID`，不再基于 email。
- [ ] magic email 登录保持现有 subject 和 claims，不携带伪造的外部来源字段。
- [ ] 删除 `server.ts` 中企业微信直接读取 secret 和直接调用成员 API 的路径；兼容 fallback 在 Task 14 统一处理。
- [ ] 为 source state 篡改、callback replay、Core 不可用、来源暂停、租户不一致、邮箱变化和无邮箱成员写测试。

### Task 13：Portal 转发和 Core canonical 登录解析

**文件：**

- 修改：`plugins/portal/src/oidc.ts`
- 修改：`plugins/portal/src/index.ts`
- 修改：`plugins/portal/test/oidc.test.ts`
- 修改：`plugins/portal/test/router.test.ts`
- 修改：`src/api/routes/organization.ts`
- 修改：`src/organization/organization-service.ts`
- 修改：`src/directory-sources/identity-linking-service.ts`
- 修改：`test/organization-service.test.ts`
- 修改：`test/organization-routes.test.ts`
- 新建：`test/external-identity-login.test.ts`

**步骤：**

- [ ] Portal 只接受由已验证 IdP token/userinfo 提供的外部身份 claims，浏览器请求参数不能覆盖。
- [ ] Portal 调用 `/v1/internal/auth/users/login` 时传 issuer、OIDC subject 和标准化外部身份，不提前把 email 决定为 `principalId`。
- [ ] Core 首先按稳定 issuer+subject/source+external subject 查现有 identity binding。
- [ ] 已绑定时返回绑定用户的 canonical `principalId`，检查外部成员 active 和 QM 成员状态。
- [ ] 未绑定时读取来源快照；缺失或过旧且 provider 支持时执行一次限时 targeted refresh。
- [ ] 使用 Task 9 matcher；唯一可信企业邮箱可原子绑定，其他结果写待处理状态并拒绝登录。
- [ ] 已配置受管来源的 `suggested | unmatched | conflict | inactive` 不得进入现有 `domain_auto_join` 分支。
- [ ] 其他未配置受管来源的 Google、Slack OIDC、magic email 和 playground 行为保持兼容。
- [ ] 修改现有“active 用户已有一个 identity 就拒绝第二个 identity”的规则：不同 managed source 可以绑定；同一 source 仍拒绝第二个成员。
- [ ] 登录失败对浏览器返回通用 reason；Admin 可以看到稳定 reason code 和证据。
- [ ] 外部 inactive 只拒绝该 source 登录，不修改 QM 用户状态，不影响其他来源身份。
- [ ] 为邮箱变化、无邮箱、重复邮箱、其他来源已绑定、同来源冲突、source 暂停、sync stale、targeted refresh 失败和 `domain_auto_join` 阻断写集成测试。

**高风险审查：** PR E 至少需要认证/claims、身份绑定/事务和隐私/错误信息三个独立审查视角；任何 reviewer 发现边界扩大时主动升级审查深度。

## 第六阶段：兼容、迁移与交付

### Task 14：实现 `.env` 兼容和部署管理来源

**文件：**

- 修改：`src/config.ts`
- 修改：`src/index.ts`
- 修改：`plugins/auth/src/config.ts`
- 修改：`compose.production.yaml`
- 修改：`docker-compose.yaml`
- 修改：`.env.example`
- 修改：`.env.production.example`
- 修改：`scripts/dev/supervisor/specs.ts`
- 修改：`scripts/production-preflight.ts`
- 修改：相关 production compose/preflight 测试

**步骤：**

- [ ] Core 将完整 `AUTH_WECOM_*` 视为 environment-backed compatibility fallback，使用同一 provider adapter，不持久化 secret；Admin 同租户配置优先，无效 fallback 不阻塞 Admin。
- [ ] 区分自建应用 Secret 与通讯录同步 Secret；前者用于登录、应用校验和成员读取，后者只用于完整通讯录枚举，未配置后者时禁止启用同步。
- [ ] Admin 将 environment source 标记为 `source=environment`、secret 不可回显，并说明通过部署轮换。
- [ ] 数据库中存在同 provider/tenant 的 managed source 时明确优先数据库配置；多实例必须得出相同结果。
- [ ] 写入 admin-managed tombstone 后允许显式关闭环境 fallback，避免删除数据库配置后旧 `.env` 静默复活。
- [ ] Auth 插件改为从 Core 获取 options 和 resolve code；迁移完成后不再需要直接持有 `AUTH_WECOM_SECRET`。
- [ ] 调整 compose、dev supervisor 和部署文档，使环境凭据只进入 Core；规划滚动顺序避免新 Auth 调用旧 Core 或旧 Auth 缺失 secret。
- [ ] production preflight 检查 partial env、重复租户、缺 `CONNECTOR_SECRET_KEY`、Core/Auth 协议版本和回调 URL。
- [ ] 为 none、partial、environment、admin-managed、disabled tombstone 和优先级写配置及 compose 测试。

### Task 15：实现现有身份对账、迁移预览和可观测性

**文件：**

- 新建：`src/directory-sources/identity-migration.ts`
- 新建：`test/directory-identity-migration.test.ts`
- 修改：`src/api/routes/admin/directory-sources.ts`
- 修改：`plugins/admin/public/index.html`
- 修改：`src/admin/metrics-sink.ts` 或现有 metrics 接口
- 修改：`plugins/admin/README.md`
- 修改：`plugins/auth/README.md`
- 修改：`README.md` 和 `README.zh-CN.md` 中相关配置说明

**步骤：**

- [ ] 扫描现有 `auth_identities`、来源成员和组织成员，生成只读迁移预览。
- [ ] 分类为已有稳定绑定、唯一企业邮箱候选、疑似重复账号、冲突和无法匹配。
- [ ] 预览不自动移动 identity、不暂停用户、不合并资源。
- [ ] 管理员从现有匹配工作台逐项确认，复用 Task 10 的 bind/rebind 事务。
- [ ] 记录来源同步成功率、数据新鲜度、匹配状态计数、登录解析结果和阻止的重复自动创建次数。
- [ ] 指标标签不包含任何个人标识；日志错误经过 provider-specific sanitizer。
- [ ] Admin 显示最近运行、待处理数量和最长等待时间，不暴露 secret 或 token。
- [ ] 更新管理员文档：来源配置、最小企业微信权限、回调地址、同步语义、失败恢复和重复账号处理。

### Task 16：完整验证、live QA、演示和审查

**受影响测试：**

```bash
node --experimental-test-module-mocks --test \
  test/directory-source-contract.test.ts \
  test/directory-source-store.test.ts \
  test/directory-source-service.test.ts \
  test/directory-sync-engine.test.ts \
  test/wecom-directory-provider.test.ts \
  test/directory-identity-match.test.ts \
  test/directory-identity-linking.test.ts \
  test/directory-identity-migration.test.ts \
  test/directory-source-routes.test.ts \
  test/external-identity-login.test.ts \
  test/organization-store.test.ts \
  test/organization-service.test.ts \
  test/organization-routes.test.ts \
  test/auth-broker-claim.test.ts \
  test/route-auth-conformance.test.ts

node --test --test-concurrency=1 \
  test/postgres-directory-source-store.test.ts \
  test/postgres-organization-store.test.ts

node --test \
  plugins/auth/test/config.test.ts \
  plugins/auth/test/flow.test.ts \
  plugins/portal/test/oidc.test.ts \
  plugins/portal/test/router.test.ts

NODE_ENV=test ALLOW_UNSIGNED_TEST_IDENTITY=1 node --test \
  plugins/admin/test/directory-sources.test.ts \
  plugins/admin/test/org-users.test.ts \
  plugins/admin/test/i18n.test.ts

npm run typecheck
npm --prefix plugins/auth run typecheck
npm --prefix plugins/portal run typecheck
npm --prefix plugins/admin run typecheck
npm run lint
npm run lint:ox
npm run format:check
```

只运行上述受影响测试和由 caller 检查发现的其他相关测试；完整套件交给 CI。PostgreSQL 测试必须至少在真实数据库上执行一次，不能只依赖 skip 结果。

**live QA：**

- [ ] 使用 `/dev-instance` skill 启动当前 worktree 的生产形态实例。
- [ ] 在 Firefox 中打开 Admin，不使用 Slack 桌面客户端完成管理 QA。
- [ ] 创建一个已有详细姓名、企业邮箱、职位、主部门、其他组织节点和访问组的 QM 成员。
- [ ] 在 Admin 创建企业微信来源，测试连接并运行初始同步预览。
- [ ] 验证同步不会改变该成员的资料、组织关系和权限。
- [ ] 使用唯一 `biz_mail` 的企业微信成员扫码，确认 session canonical principal 是已有成员。
- [ ] 修改同步 fixture 中的个人邮箱和企业邮箱显示值，保留相同 UserID，再次扫码仍进入同一成员。
- [ ] 制造重复邮箱和员工编号冲突，确认扫码失败、没有新 `organization_users`、Admin 出现 conflict。
- [ ] 完成手工绑定后重新扫码成功。
- [ ] 将同一个 QM 成员绑定第二个不同来源 fixture，确认允许；同一来源第二个成员确认拒绝。
- [ ] 验证 source 暂停、login 关闭、sync 关闭、external inactive、QM suspended 和 deprovisioned 的不同结果。
- [ ] 执行 rebind，确认旧/新用户会话失效且历史资源没有移动。
- [ ] 模拟 provider 超时、分页中途失败和 Core/Auth 短暂不可用，确认旧快照不被错误清空且登录 fail closed。

**前端演示：**

- [ ] 提供可点击的 Admin demo，使用 mock Core API 展示来源列表、创建向导、同步运行、冲突处理和 rebind；PR 说明哪些接口和数据是 mock。
- [ ] 若 live demo 不可行，至少提供创建前后、初始同步、匹配冲突、绑定确认和来源暂停截图。
- [ ] 所有截图使用真实感但不包含真实企业成员、CorpID、UserID、邮箱、手机号或 secret。

**审查：**

- [ ] PR A：数据模型、迁移和事务 reviewer。
- [ ] PR B：管理授权、secret handling 和前端 reviewer。
- [ ] PR C：并发、租约、重试和数据丢失 reviewer。
- [ ] PR D：身份误绑、session invalidation 和隐私 reviewer。
- [ ] PR E：至少认证协议、Core 身份解析、攻击面三个独立 reviewer。
- [ ] PR F：部署兼容、迁移和实际运维 reviewer。
- [ ] 解决全部发现并补回归测试后，才允许合并对应 PR。

## 完成定义

- [ ] PRD 的全部第一阶段验收标准都有自动化测试或明确 live QA 证据。
- [ ] 企业微信扫码的 canonical 身份由 `CorpID + UserID` 决定，邮箱变化不改变账号。
- [ ] 已启用受管来源的未匹配登录不会创建新组织用户。
- [ ] Admin 能完成来源配置、连接测试、同步、冲突查看、手工绑定和纠正绑定。
- [ ] 不同来源可以绑定同一成员，同一来源唯一约束严格生效。
- [ ] 同步、绑定、纠正绑定和审计满足事务、持久化和多实例要求。
- [ ] Secret 和个人资料没有出现在日志、审计正文、指标标签、浏览器缓存或 API 非授权响应中。
- [ ] 现有 Google/Slack OIDC、magic email、playground、Slack directory 和组织成员管理回归测试通过。
- [ ] Admin 变更有 demo 或截图，企业微信登录有 Firefox live QA 记录。
- [ ] 所有 PR 均完成 fresh-context review，并只合并到当前私有 fork。
