# 组织成员管理开发计划

**目标：** 按 [`organization-member-management-prd.md`](../../organization-member-management-prd.md) 完成组织成员主数据、成员生命周期、CSV 导入导出和批量操作，同时保持组织授权、身份校验和审计的严格一致性。

**架构：** 扩展现有 `src/organization/` store/service，而不是新增第二套用户目录。`organization_users` 保存成员主数据，`org_unit_members` 保存主部门和其他节点关系，`access_group_members` 保存访问组关系。Core 提供管理查询和写入真相，Admin 插件只做身份验证、代理和展示。第二阶段批量任务使用持久化 job/item 表，预检查和提交分离，提交在一个组织事务中完成。

**范围：** 本计划不实现账号创建、邀请、待激活成员、邮件或企业微信邀请。现有 `invited` 仅保留后端兼容，不进入 Admin 产品流程。

**技术栈：** TypeScript、Node.js ≥24、`node:test`、PostgreSQL、vanilla JavaScript Admin SPA。不得新增 npm 依赖。

## 全局约束

- 修改前以当前工作区为准，保留所有无关未提交改动。
- Core、Memory store 和 PostgreSQL store 行为一致。
- 不在插件中导入 Core；Admin 插件通过签名 HTTP 调用 Core。
- 所有管理查询和写入携带 `org_id`，跨组织目标 fail closed。
- Store 提供持久化和事务原语，Service 实现业务规则，Route 只做认证、输入解析和序列化。
- 资料写、状态写、组织关系写与审计同事务。
- 只有授权相关变化递增 `organization_authz_state.revision`；姓名、职务、手机等纯资料修改只递增用户 `profileRevision`。
- 批量授权变化整批最多递增一次组织授权 revision。
- 手机、员工编号和 CSV 正文不得进入普通日志、指标标签或错误堆栈。
- 不使用进程内 `Map` 保存生产批量任务；没有 durable job store 时批量接口返回 `503 not_configured`。
- 每个任务先写受影响测试，再实现，再运行对应测试。
- 本计划中的代码不得新增注释、docblock、TODO、lint/type suppression 或注释掉的代码。

## 推荐 PR 划分

1. **PR A：成员主数据和 Core 管理 API**
   - Schema、store、service、登录资料归属、状态机、管理 API。
2. **PR B：Admin 组织成员 UI**
   - Admin 代理、成员列表/详情、节点和访问组详情增强、Firefox QA 和截图。
3. **PR C：批量任务基础设施与 CSV 导入导出**
   - Durable jobs、CSV 解析/导出、预检查、提交、任务 UI。
4. **PR D：批量成员操作**
   - 批量资料、组织关系、访问组和状态操作、影响预览、完整 QA。

每个 PR 独立通过受影响测试、typecheck、lint，并由未参与实现的 fresh-context reviewer 审查。不得把未完成的高风险批量写入口隐藏在 UI 后合并。

## 第一阶段：成员主数据与生命周期

### Task 1：冻结契约和测试夹具

**文件：**

- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/organization-service.ts`
- 修改：`test/organization-store.test.ts`
- 修改：`test/organization-service.test.ts`

**步骤：**

- [ ] 增加成员资料和详情查询所需类型：
  - `OrganizationUser` 增加 `jobTitle`, `mobile`, `employeeNumber`, `profileRevision`。
  - `OrgUnitMember` 增加 `isPrimary`。
  - 定义 `OrganizationUserListQuery`, `OrganizationUserCursor`, `OrganizationUserPage`。
  - 定义包含用户、组织节点关系和访问组关系的 `OrganizationUserDetail`。
- [ ] 定义字段规范化边界和状态转换结果类型。
- [ ] 更新测试工厂，所有 `OrganizationUser` 和 `OrgUnitMember` fixture 显式包含新增字段。
- [ ] 使用 `rg` 扫描 `src/`, `plugins/`, `test/`, `scripts/` 中全部 `OrganizationUser` 和 `OrgUnitMember` 对象字面量，统一更新，不留下只在未运行测试中才暴露的旧结构。
- [ ] 为以下契约写失败测试：
  - 用户资料 round-trip。
  - 同一成员最多一个主部门。
  - active、suspended、deprovisioned 的允许转换。
  - deprovisioned 不能恢复 active。
  - `invited` 不由管理状态接口创建。
- [ ] 运行：

```bash
node --experimental-test-module-mocks --test test/organization-store.test.ts test/organization-service.test.ts
```

预期：新增测试先失败，类型错误指向未实现字段和方法。

### Task 2：扩展 PostgreSQL schema 和行映射

**文件：**

- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`test/postgres-organization-store.test.ts`

**Schema：**

`organization_users` 增加：

- `job_title TEXT`
- `mobile TEXT`
- `employee_number TEXT`
- `profile_revision BIGINT NOT NULL DEFAULT 1`

`org_unit_members` 增加：

- `is_primary BOOLEAN NOT NULL DEFAULT FALSE`

索引和约束：

- 组织内非空 `employee_number` 唯一。
- `(org_id, principal_id)` 在 `is_primary=true` 时唯一。
- 主部门关系仍通过现有复合外键验证用户和组织节点同组织。

**步骤：**

- [ ] 使用现有 `SCHEMA_SQL` expand 模式增加 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`。
- [ ] 增加 partial unique index，不对现有关系自动设置主部门。
- [ ] 扩展 `USER_COLUMNS`, `UNIT_MEMBER_COLUMNS`, `rowToUser`, `rowToUnitMember` 和所有 insert/upsert。
- [ ] 为老 schema 升级、空字段、唯一员工编号、唯一主部门和多 store 实例持久化写 PostgreSQL 测试。
- [ ] 验证并发把两个节点设为主部门时最多一个事务成功。
- [ ] 运行：

```bash
node --test --test-concurrency=1 test/postgres-organization-store.test.ts
```

没有 `DATABASE_URL` 时测试可以按现有规则 skip；开发和 PR 前必须在真实 PostgreSQL 上跑一次。

### Task 3：实现成员管理查询

**文件：**

- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`src/organization/organization-service.ts`
- 修改：`test/organization-store.test.ts`
- 修改：`test/postgres-organization-store.test.ts`

**接口：**

- `listUsersPage(orgId, query)`：服务端过滤、稳定排序和游标分页。
- `getUserDetail(orgId, principalId)`：一次返回用户、节点关系和访问组关系。
- `getUsersByPrincipalIds(orgId, principalIds)`：节点/访问组详情批量关联资料。

**查询要求：**

- `匹配规范化后的姓名、邮箱、职务、手机号、员工编号和 `principalId。
- 支持 status、unitId、是否包含后代、groupId、是否缺少主部门。
- PostgreSQL 在可见性和状态过滤后再排序、分页和计数。
- 游标至少包含 `displayName` 和 `principalId`。
- 列表不得为每行再次查询组织关系。

**步骤：**

- [ ] 先为 memory store 写组合筛选、稳定分页、重名用户、跨组织隔离和空结果测试。
- [ ] 实现 memory store 行为。
- [ ] 为 PostgreSQL 写与 memory store 相同的参数化测试。
- [ ] 使用一次用户页查询加批量关系查询，禁止浏览器 N+1。
- [ ] 为节点子树筛选复用 closure table，不在应用层递归全量树。
- [ ] 验证 deprovisioned 默认不进入 active 候选搜索，但管理列表显式筛选时可见。

### Task 4：实现资料更新和登录资料归属

**文件：**

- 修改：`src/organization/organization-service.ts`
- 修改：`test/organization-service.test.ts`
- 修改：`test/organization-routes.test.ts`

**Service：**

- `updateUserProfile({ principalId, patch, expectedProfileRevision, actor })`
- 字段规范化函数保留在 `organization-service.ts`，不为单一调用制造额外模块。

**步骤：**

- [ ] 为姓名、邮箱、职务、手机和员工编号的 trim、长度、控制字符和空值写表驱动测试。
- [ ] 为重复邮箱、重复员工编号和未知用户写冲突测试。
- [ ] 使用 `profileRevision` 做 CAS；冲突不写资料、不递增 revision、不写成功审计。
- [ ] 资料更新事务内写 `org.user.profile` 审计，detail 只记录字段名和脱敏摘要。
- [ ] 修改 `withLoginProfile`：
  - 总是更新 `lastLoginAt`。
  - 仅在成员字段为空时用受信登录资料填补姓名或邮箱。
  - 不覆盖管理员维护的非空姓名和邮箱。
  - 登录填补资料时递增 `profileRevision`。
- [ ] 写回归测试覆盖管理员编辑后再次登录、身份邮箱变化和空字段首次填补。
- [ ] 确认纯资料更新不递增组织授权 revision。

### Task 5：实现主部门和成员聚合详情

**文件：**

- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`src/organization/organization-service.ts`
- 修改：`test/organization-service.test.ts`
- 修改：`test/postgres-organization-store.test.ts`

**Service：**

- `setPrimaryUnit({ principalId, unitId, keepPreviousMembership, actor })`
- `clearPrimaryUnit({ principalId, keepMembership, actor })`

**步骤：**

- [ ] 设置主部门时验证用户不是 deprovisioned、节点 active 且同组织。
- [ ] 若目标节点没有成员关系，在同一事务创建 `role=member, isPrimary=true`。
- [ ] 替换主部门时原关系根据显式参数保留为普通关系或删除。
- [ ] 清除主部门时同样要求显式保留或删除关系。
- [ ] 修改现有 add/remove unit member：
  - 更新角色时保留 `isPrimary`。
  - 删除主部门关系时拒绝并返回需要先清除主部门的错误。
- [ ] 一次事务只递增一次组织授权 revision并写审计。
- [ ] 测试主部门替换、清除、归档节点、并发和 manager 越权。

### Task 6：收紧成员状态机和离职语义

**文件：**

- 修改：`src/organization/organization-service.ts`
- 修改：`src/api/routes/organization.ts`
- 修改：`test/organization-service.test.ts`
- 修改：`test/organization-routes.test.ts`
- 修改：`test/organization-gate.test.ts`
- 修改：`test/identity-offboarding.test.ts`

**步骤：**

- [ ] 将管理状态转换限制为：
  - active → suspended/deprovisioned
  - suspended → active/deprovisioned
  - deprovisioned → 无
- [ ] 保留登录准入内部对 `invited` 的兼容转换，但 Admin 管理接口拒绝目标状态 `invited`。
- [ ] 增加状态影响查询，返回节点、manager、访问组和直接授权数量。
- [ ] 状态写始终递增 `sessionVersion` 和组织授权 revision，并在同一事务写审计。
- [ ] 暂停和离职后调用现有 identity deactivation，使本实例立即失效；其他实例通过持久化状态/revision 在下一请求 fail closed。
- [ ] 确认 active-only 检查让 deprovisioned 的管理员、节点 manager、组 manager 和 Skill 使用权全部失效。
- [ ] 禁止普通恢复 deprovisioned，避免旧关系再次生效。
- [ ] 保护最后一名 active 组织管理员：其暂停或离职返回 `409`，必须先授予另一名 active 管理员。
- [ ] 测试旧 Portal session、旧 capability、manager API、目录和 Skill 候选在状态变化后均拒绝。
- [ ] 测试影响预览和执行之间发生变化时服务端使用最新事实。

### Task 7：新增和扩展 Core 管理 API

**文件：**

- 修改：`src/api/routes/organization.ts`
- 修改：`src/api/agent-api-catalog.ts`
- 修改：`test/organization-routes.test.ts`

**Routes：**

```text
GET   /v1/admin/org/users
GET   /v1/admin/org/users/:principalId
PATCH /v1/admin/org/users/:principalId
GET   /v1/admin/org/users/:principalId/impact
POST  /v1/admin/org/users/:principalId/status
PUT   /v1/admin/org/users/:principalId/primary-unit
```

现有 `GET /v1/admin/org/users/search` 保留给 active 候选选择器。现有 `PATCH .../:principalId` 状态写调用方迁移到显式 status endpoint 后，只处理资料 patch；兼容窗口内若仍接受旧请求，必须走相同状态机，不得保留第二套逻辑。

**步骤：**

- [ ] 列表解析 q、status、unitId、includeDescendants、groupId、missingPrimaryUnit、cursor 和 limit。
- [ ] 管理列表和详情只允许组织管理员；manager 继续使用已有受限节点/组详情和 active 搜索。
- [ ] 资料 patch 严格拒绝未知字段、空请求、错误类型和超长值。
- [ ] 所有 mutation 拒绝 agent capability，只接受可信 Portal 管理身份。
- [ ] 节点和访问组详情使用批量资料关联，按角色移除 `mobile` 和 `employeeNumber`。
- [ ] 不可见或跨组织用户统一返回 `404`；资料 revision 冲突返回 `409`。
- [ ] 更新 API catalog 和 route 测试。

### Task 8：Admin 插件代理

**文件：**

- 修改：`plugins/admin/src/index.ts`
- 新建：`plugins/admin/test/org-users.test.ts`
- 修改：`plugins/admin/test/org-units.test.ts`
- 修改：`plugins/admin/test/org-groups.test.ts`

**步骤：**

- [ ] 为成员资料 PATCH、状态 POST 和主部门 PUT 增加精确路径转发，不把 `org-users` 加入宽泛的 POST 通配列表。
- [ ] 明确拒绝或不匹配 `POST /api/org-users`，现有 Core 邀请接口不得因此暴露给 Admin UI。
- [ ] 明确 manager 只允许 `/api/org-users/search`，不能访问成员管理列表、详情和 mutation。
- [ ] 增加 GET 列表/详情、PATCH 资料、POST status、PUT primary-unit 的签名转发测试。
- [ ] 增加未登录、普通用户、manager 和组织管理员矩阵测试。
- [ ] 验证代理不会把响应或请求正文写入日志。

### Task 9：Admin 组织成员页面

**文件：**

- 修改：`plugins/admin/public/index.html`
- 修改：`plugins/admin/test/i18n.test.ts`
- 修改或新建 Admin 页面结构测试。

**步骤：**

- [ ] 在 Admin 导航增加 `org-members`，只对组织管理员显示。
- [ ] 保留现有 `users` 运行视图，更新中英文标题和说明以避免混淆。
- [ ] 实现组织树和成员表格双栏布局。
- [ ] 实现 q、status、unit、subtree、group、missing-primary 筛选和游标分页。
- [ ] 默认显示 active 和 suspended，deprovisioned 通过显式筛选查看。
- [ ] 实现成员详情：资料、状态、主部门、其他节点、访问组、身份和审计。
- [ ] 实现资料编辑和 `409` 冲突处理。
- [ ] 实现主部门、节点和访问组关系操作。
- [ ] 实现暂停、恢复和离职影响预览及确认。
- [ ] 节点和访问组详情表格改为姓名、职务、邮箱、状态、角色和主部门标记。
- [ ] manager 模式不渲染手机号、员工编号、资料编辑和状态按钮。
- [ ] 补齐中文翻译和空状态、错误状态、loading 状态。
- [ ] 不在浏览器缓存完整成员清单或手机号。

### Task 10：第一阶段验证和交付

**受影响测试：**

```bash
node --experimental-test-module-mocks --test \
  test/organization-store.test.ts \
  test/organization-service.test.ts \
  test/organization-routes.test.ts \
  test/organization-gate.test.ts \
  test/identity-offboarding.test.ts \
  plugins/admin/test/org-users.test.ts \
  plugins/admin/test/org-units.test.ts \
  plugins/admin/test/org-groups.test.ts \
  plugins/admin/test/i18n.test.ts
node --test --test-concurrency=1 test/postgres-organization-store.test.ts
npm run typecheck
npm run lint
npm run format:check
```

**人工与 live QA：**

- [ ] 使用 `/dev-instance` 启动当前 worktree。
- [ ] 在 Firefox 登录 Admin，验证组织管理员完整流程。
- [ ] 验证 manager 只能维护其范围内普通成员关系。
- [ ] 验证资料编辑后退出并重新登录，姓名和邮箱不被覆盖。
- [ ] 验证暂停后旧页面下一请求立即失效，恢复后重新登录成功。
- [ ] 验证离职后不能恢复，目录、候选和 Skill 中均不可见。
- [ ] 使用真实感数据截取成员列表、详情编辑和离职影响确认截图。
- [ ] PR 描述附截图和 QA 步骤，说明哪些数据是本地模拟。
- [ ] 派发未参与实现的 fresh-context reviewer，解决全部发现后再合并。

## 第二阶段：CSV 与批量操作

### Task 11：持久化批量任务 store

**文件：**

- 新建：`src/organization/member-job-store.ts`
- 新建：`src/organization/postgres-member-job-store.ts`
- 新建：`test/member-job-store.test.ts`
- 新建：`test/postgres-member-job-store.test.ts`
- 修改：`src/wiring.ts`

**表：**

`organization_member_jobs`：

- id、org_id、kind、status、actor_id、idempotency_key。
- input_hash、expected_authz_revision、summary JSONB。
- created_at、started_at、completed_at、expires_at、error。

`organization_member_job_items`：

- org_id、job_id、item_index、principal_id。
- expected_profile_revision、normalized_input JSONB、changes JSONB。
- status、errors JSONB、warnings JSONB。

**步骤：**

- [ ] 定义 job/item 类型和 store 接口。
- [ ] memory store 只用于单元测试；生产 wiring 没有 PostgreSQL 时不提供 batch service。
- [ ] PostgreSQL 使用 `(org_id, id)` 和 `(org_id, job_id, item_index)` 主键或唯一约束。
- [ ] `(org_id, actor_id, idempotency_key)` 唯一，重复提交返回原任务。
- [ ] 任务和 items 写入、running claim、complete/fail 在事务内更新。
- [ ] 所有读取按 org_id 和 actor/管理员权限隔离。
- [ ] 使用 `src/util/sweeper.ts` 清理过期任务的 item 正文；保留审计摘要。
- [ ] 测试重启持久化、并发 claim、幂等和过期清理。

### Task 12：CSV 解析和安全导出

**文件：**

- 新建：`src/organization/member-csv.ts`
- 新建：`test/organization-member-csv.test.ts`

**步骤：**

- [ ] 实现 UTF-8 BOM、CRLF/LF、引号、双引号转义和带换行单元格解析。
- [ ] 最大 5 MiB、5,000 行、100 列和单元格长度上限。
- [ ] 拒绝 NUL、无效 UTF-8、重复表头和未知必需字段。
- [ ] 导出按 RFC 4180 转义并添加 UTF-8 BOM。
- [ ] 对以 `=`, `+`, `-`, `@` 开头的导出单元格做公式注入防护。
- [ ] 测试中文、逗号、引号、换行、空值、超限和公式 payload。
- [ ] 不把 CSV 内容放进错误信息或日志。

### Task 13：CSV 导出 API

**文件：**

- 修改：`src/api/routes/organization.ts`
- 修改：`plugins/admin/src/index.ts`
- 修改：`plugins/admin/public/index.html`
- 修改：`test/organization-routes.test.ts`
- 修改或新建 Admin 代理测试。

**步骤：**

- [ ] `GET /v1/admin/org/users/export` 复用成员列表过滤和权限逻辑。
- [ ] Core 流式返回 CSV，避免构造第二份全量字符串。
- [ ] Admin 插件使用下载转发，不把 CSV 当 JSON 读取。
- [ ] 文件名包含日期，不包含组织名、成员名或其他敏感字段。
- [ ] 组织管理员页面增加“导出当前结果”和“导出全部”。
- [ ] 导出动作记录过滤摘要、行数和 actor，不记录内容。
- [ ] 测试 manager/普通用户拒绝、过滤一致性和公式防护。

### Task 14：导入预检查

**文件：**

- 新建：`src/organization/member-batch-service.ts`
- 修改：`src/api/routes/organization.ts`
- 修改：`src/wiring.ts`
- 新建：`test/organization-member-batch.test.ts`
- 修改：`test/organization-routes.test.ts`

**步骤：**

- [ ] `POST /v1/admin/org/users/imports/preview` 接收 `text/csv`，校验大小和 Content-Type。
- [ ] 按 principalId、employeeNumber、email 顺序解析已存在成员。
- [ ] 批量读取用户、节点和访问组，不逐行查数据库。
- [ ] 规范化资料、主部门、其他节点和普通访问组变化。
- [ ] 未匹配用户只报错，绝不创建账号或 invited 用户。
- [ ] 检测重复、归档、跨组织、路径歧义、唯一约束和无变化行。
- [ ] 把预检查任务和 normalized items 持久化，保存文件哈希和当前 authz revision。
- [ ] 返回任务汇总和分页错误明细，不回传原始 CSV。
- [ ] 测试刷新/重启后仍能读取预检查结果。

### Task 15：导入提交

**文件：**

- 修改：`src/organization/member-batch-service.ts`
- 修改：`src/organization/organization-store.ts`
- 修改：`src/organization/postgres-organization-store.ts`
- 修改：`src/api/routes/organization.ts`
- 修改：`test/organization-member-batch.test.ts`
- 修改：`test/postgres-organization-store.test.ts`

**步骤：**

- [ ] `POST /v1/admin/org/users/imports/:jobId/commit` 校验 actor、org、状态、过期、哈希和 idempotency。
- [ ] 提交前验证 authz revision 和每名用户的 profileRevision。
- [ ] 在一个 organization transaction 中应用全部资料和关系变化。
- [ ] 任一 item 失败时整体回滚，job 标为 failed 并保存脱敏原因。
- [ ] 仅资料变化不递增 authz revision；存在关系变化时整批只递增一次。
- [ ] 写任务摘要审计和成员级字段/关系审计。
- [ ] 成功后把 job 和 items 标为 completed，重复 commit 返回相同结果。
- [ ] 测试唯一约束竞态、revision 冲突、进程重试、审计失败和事务回滚。

### Task 16：批量影响预览和提交

**文件：**

- 修改：`src/organization/member-batch-service.ts`
- 修改：`src/api/routes/organization.ts`
- 修改：`test/organization-member-batch.test.ts`
- 修改：`test/organization-routes.test.ts`

**支持操作：**

- set_job_title
- set_primary_unit / clear_primary_unit
- add_unit / remove_unit
- add_group / remove_group
- suspend / reactivate / deprovision

**步骤：**

- [ ] preview 接收明确 principalIds 或服务端筛选表达式。
- [ ] preview 时把筛选表达式解析为明确 principalId 集合并持久化，最大 5,000 人。
- [ ] manager role、组织管理员授权和账号创建不在 action enum 中。
- [ ] add/remove unit 和 group 只处理普通 member 关系；目标已有 manager 关系时预检查报冲突，不降级、覆盖或移除 manager。
- [ ] 预览返回变化数、无变化数、冲突、manager 数量、组/节点影响和最后管理员风险。
- [ ] commit 重新验证明确目标集合，不重新执行筛选扩大范围。
- [ ] 在一个事务应用全部变化，整批只递增一次 authz revision。
- [ ] deprovision 目标包含最后一名 active 管理员时整批拒绝。
- [ ] 重复提交同一幂等键返回原任务。
- [ ] 测试 0、1、100、5,000 人，混合状态、重复 ID、跨组织和并发 revision。

### Task 17：第二阶段 Admin UI

**文件：**

- 修改：`plugins/admin/public/index.html`
- 修改：`plugins/admin/src/index.ts`
- 修改：`plugins/admin/test/i18n.test.ts`
- 修改：`plugins/admin/test/org-users.test.ts`

**步骤：**

- [ ] 成员列表启用多选、当前页全选和明确筛选集合操作。
- [ ] 增加 CSV 模板说明、上传、预检查结果和错误明细分页。
- [ ] 有错误任务禁用提交按钮。
- [ ] 提交前再次展示目标数、变化数和危险状态操作影响。
- [ ] 增加任务状态页，刷新页面后从 Core 重新读取。
- [ ] running 状态使用有限轮询，页面离开后停止；任务真相始终来自持久化 store。
- [ ] 增加导出当前结果和全部成员。
- [ ] 批量暂停、恢复和离职使用独立危险确认文案。
- [ ] manager 和普通用户不显示批量入口，Core 仍独立拒绝。
- [ ] 补齐中英文翻译和可访问名称。

### Task 18：第二阶段验证和交付

**受影响测试：**

```bash
node --experimental-test-module-mocks --test \
  test/member-job-store.test.ts \
  test/organization-member-csv.test.ts \
  test/organization-member-batch.test.ts \
  test/organization-store.test.ts \
  test/organization-service.test.ts \
  test/organization-routes.test.ts \
  plugins/admin/test/org-users.test.ts \
  plugins/admin/test/i18n.test.ts
node --test --test-concurrency=1 \
  test/postgres-member-job-store.test.ts \
  test/postgres-organization-store.test.ts
npm run typecheck
npm run lint
npm run format:check
```

**压力和故障验证：**

- [ ] 5,000 行导入预检查和提交。
- [ ] 5,000 人批量关系变更只递增一次 authz revision。
- [ ] Core 在 preview 后、commit 前重启。
- [ ] commit 响应丢失后使用相同幂等键重试。
- [ ] 两个 Core 实例并发 commit 同一任务。
- [ ] 审计写入失败导致业务写回滚。
- [ ] 组织树或成员资料在 preview 后变化导致 `409`，不部分写入。
- [ ] CSV 公式 payload、超长单元格、无效 UTF-8 和跨组织 ID 被拒绝。

**人工与 live QA：**

- [ ] 使用 `/dev-instance` 在 Firefox 完成导出、预检查、错误修复、提交和任务历史流程。
- [ ] 使用真实感中文姓名、部门路径、国际手机号、逗号和换行字段验证 CSV。
- [ ] 验证刷新页面和重启实例后任务仍可查看。
- [ ] 验证 manager 看不到且不能调用导入导出或批量接口。
- [ ] PR 提供导入预检查、批量影响确认和任务完成状态截图。
- [ ] 由未参与实现的 reviewer 分别从数据一致性、权限和 CSV 安全三个视角审查。

## 完成定义

只有同时满足以下条件，阶段才算完成：

- PRD 对应阶段的全部验收项通过。
- Memory 和 PostgreSQL 行为一致，PostgreSQL 测试在真实数据库运行通过。
- 受影响测试、typecheck、lint 和 format check 通过。
- 非平凡 Admin 行为已通过 `/dev-instance` 在 Firefox 验证。
- PR 包含可查看的前端演示材料。
- fresh-context review 的发现全部解决。
- 未把邀请、待激活、账号创建或外部目录同步混入本次实现。
