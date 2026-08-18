# 组织目录与 Skill 授权设计

## 文档状态

| 项目 | 值 |
| --- | --- |
| 状态 | 提议，尚未实施 |
| 版本 | 1.1 |
| 日期 | 2026-08-17 |
| 适用范围 | Portal 登录用户、项目成员目录、组织管理、Skill 可见与执行权限 |
| 权威数据源 | Core PostgreSQL |

本文档是组织目录和 Skill 授权功能的开发依据。文中的“必须”表示安全或兼容性要求；“建议”表示首期实现可以调整，但调整后仍需满足验收标准。

## 1. 结论

目标方案支持以下能力：

- 内部持久化用户表，不依赖 Slack 才能登录、搜索用户或添加项目成员。
- 严格单父节点的树形组织架构。
- 独立的扁平权限组。
- 用户默认查看整个组织，也可以被限制到多个组织子树。
- 组织可见范围支持复选，多个允许范围取并集。
- Skill 访问范围支持“所属范围”“全组织”“受限范围”。
- Skill 受限范围可同时复选多个组织节点、权限组和指定人员。
- 单个用户命中任一 Skill 授权即有使用权；多人会话必须所有当前受众都拥有使用权。
- 页面、API、Agent Prompt、Sandbox、Cron 和后台执行共用服务端授权解析器。
- 用户停用、移组、组织节点移动和撤销授权后，下一次请求与下一轮执行立即失效。

两个“复选”使用相同的并集语义，但不能混为同一种权限：

```text
目录可见范围 = 可见组织子树 A ∪ 子树 B ∪ 子树 C

单人 Skill 使用权 = 用户直接授权 ∪ 组织节点授权 ∪ 权限组授权

多人会话可使用 Skill = 会话完整受众中的每个人都拥有单人使用权
```

目录可见性只决定一个人可以查看哪些组织节点和人员，不自动授予 Skill 使用权。Skill 使用权也不自动授予组织目录查看权。

## 2. 目标与非目标

### 2.1 目标

1. 建立内部用户与 OIDC 身份的权威映射。
2. 建立树形部门、团队以及独立权限组。
3. 为组织树和人员搜索提供严格、可配置的可见范围。
4. 为 Skill 提供全组织、组织节点、权限组和指定人员授权。
5. 将所有授权判断收敛到统一的 Core 服务端实现。
6. 保持组织隔离、即时撤权、并发安全和可审计。
7. 将项目成员选择器改为使用内部用户目录。

### 2.2 首期非目标

- 不允许权限组嵌套。
- 不实现通用 deny 规则。
- 不实现跨组织用户、组织节点或 Skill 授权。
- 不把 Skill 的使用权自动升级为编辑、发布或转授权权限。
- 不把 Slack、OIDC Token 中的组声明或浏览器状态作为组织成员关系的权威数据源。
- 不实现“用户可以执行 Skill 但完全看不到 Skill 指令”的黑盒执行模式。现有执行机制会把 Skill 内容放入 Prompt 或 Sandbox，`use` 因而包含发现、读取和执行。
- 不在首期建设任意资源、任意动作、任意条件的完整通用 RBAC 平台。
- CLI 的本地 contract-layer skill（`cli/` 下的 sandbox-layer、check、conformance 路径）不经 Core Skill 存储，不适用本授权体系。

## 3. 当前实现与缺口

### 3.1 用户和登录

Portal OIDC 回调会解析 principal 和显示名，然后把它们写入签名 Cookie，但不会在 Core 中持久化用户档案。相关代码位于 [`plugins/portal/src/index.ts`](../plugins/portal/src/index.ts)。

Core 当前的 IdentityService 只持久化已停用 principal。未知 principal 只要未被停用，就会被分类为 internal，属于 fail-open。相关实现位于 [`src/identity/identity-service.ts`](../src/identity/identity-service.ts)。

### 3.2 外部目录

`directory_members`、`directory_group_members` 和 `directory_sync` 是外部目录同步快照。它们没有完整用户生命周期、组织节点、父子关系或内部权限组，而且上游同步可以全量替换数据。相关 schema 位于 [`src/directory/postgres-directory-store.ts`](../src/directory/postgres-directory-store.ts)。

这些表可以继续保存 Slack ID、外部显示名等补充资料，但不能成为内部用户状态、组织成员关系或授权判断的权威来源。

### 3.3 Scope 和 ACL

现有 Scope 包含 `personal`、`team`、`org`、`channel` 和 `group`，但 `Principal.teamIds` 没有内部持久化组织模型支撑。相关类型位于 [`src/types.ts`](../src/types.ts)。

现有 `acl_grants` 已能持久化资源 owner、resource ref、grantee 和 `read/write` 权限，且资源 ref 已支持 `skill:<id>`。相关实现位于：

- [`src/acl/postgres-grant-store.ts`](../src/acl/postgres-grant-store.ts)
- [`src/acl/resource-ref.ts`](../src/acl/resource-ref.ts)
- [`src/acl/acl-store.ts`](../src/acl/acl-store.ts)

当前问题包括：

- ACL 表没有显式 `org_id`。
- `org`、`team` owner scope 的管理检查存在默认放行路径。
- Skill 分享能够写入 grant，但 Skill 列表和运行时不消费这些 grant。
- 当前 `grantsOfKind` 只处理 org-owned 资源，不能直接覆盖任意 home scope 的 Skill。

### 3.4 Skill 页面和运行时

Web Skill 创建页已有“Available to”下拉框，但只包含个人和当前可写的私有 channel/group context，没有全组织、内部组织节点、权限组或指定人员多选。相关实现位于 [`plugins/web-ui/src/skills.ts`](../plugins/web-ui/src/skills.ts)。

当前 Skill 可见性与执行主要按 `scopeId` 计算：

- Web/API 列表：[`src/api/app-skills.ts`](../src/api/app-skills.ts)
- Skill 查询和详情：[`src/api/routes/surface.ts`](../src/api/routes/surface.ts)
- Agent Prompt：[`src/core/orchestrator.ts`](../src/core/orchestrator.ts)
- Sandbox 物化与延迟读取：[`src/core/orchestrator/sandboxes.ts`](../src/core/orchestrator/sandboxes.ts)

因此只增加前端选择器不会形成权限边界。

## 4. 核心概念

### 4.1 人类用户

人类用户是能够通过 Portal 登录的组织成员。状态固定为：

```text
invited       已邀请，尚未完成受控激活
active        可以登录并参与权限计算
suspended     暂停使用，可恢复
deprovisioned 已离职或永久停用，不再参与授权
```

只有 `active` 用户可以获得标准 Portal 会话、读取组织目录、进入项目、发现或执行 Skill。`invited` 用户只能访问一次性激活流程，不能调用 `/v1/me` 或其他业务 API。

### 4.2 组织节点

组织节点组成严格的树：

```text
组织根节点
├── 研发部
│   ├── 平台组
│   └── 应用组
└── 财务部
    ├── 核算组
    └── 预算组
```

一个组织节点最多只有一个父节点。用户可以直接属于一个或多个节点。用户属于子节点时，其有效组织主体同时包含该节点的全部祖先节点。

### 4.3 权限组

权限组用于跨部门授权，例如“数据委员会”“采购审批人”“AI 高级用户”。权限组与组织树独立，首期保持扁平，只计算直接成员。

### 4.4 目录可见范围

目录可见范围控制用户能看到哪些组织节点和人员，包括：

- 组织树页面。
- 人员搜索与自动补全。
- 组织节点成员列表。
- 用户详情。
- 项目添加成员候选。
- Skill 授权目标选择器。

### 4.5 Skill 使用权

Skill 使用权控制：

- 是否出现在 Skill 列表和自动补全中。
- 是否能读取 Skill 详情和内容。
- 是否能进入 Agent Prompt。
- 是否能写入或保留在 Sandbox。
- 是否能在 Cron、Trigger、项目或其他后台执行中使用。

Skill 使用权与 Skill 管理权分离。获得 `use` 不代表可以编辑、发布、归档或修改访问策略。

### 4.6 管理角色

组织管理员沿用现有 `admin_grants` 存储的 `org_admin` 角色（含 `ADMIN_GRANTS` 启动种子和 last-admin 撤销保护，相关实现位于 [`src/admin/admin-service.ts`](../src/admin/admin-service.ts)），不新建并行的管理员表。组织节点 manager、权限组 manager 来自成员表角色，Skill manager 按 6.7 定义。

所有管理角色都要求主体是同组织 active 用户：主体被停用或离职后，其全部管理角色立即失效，剩余职责由组织管理员重新指派。任何角色变更必须与组织授权 revision 递增和审计写入在同一事务完成。

## 5. 权限决策

### 5.1 显式模式优于缺省推导

目录可见策略和 Skill 访问策略都必须保存显式模式，不能通过“有没有授权行”推导。

如果删除最后一个允许对象：

- `limited` 目录策略仍然是空范围，不能恢复为全组织。
- `restricted` Skill 仍然无人可用，不能变成全组织。

只有显式切换模式或删除整个覆盖策略，才允许恢复上级默认规则。

### 5.2 允许规则首期采用 allow-only

首期不实现 deny。多选对象一律取并集，结果确定且容易审计。

如果需要排除某个子团队，应当选择更精确的允许节点，或创建专用权限组。以后只有出现无法通过允许集合表达的真实需求时，再设计 deny 优先级。

### 5.3 组织节点和权限组是不同主体

授权主体使用明确类型：

```text
personal:<principalId>
org-unit:<unitId>
access-group:<groupId>
org:<orgId>
```

不能继续使用 Slack `group:*` 或未经内部数据库验证的 `teamIds` 作为组织主体。若实现阶段需要兼容旧 `team:*`，只能通过服务端迁移适配器映射，不能让客户端自行构造。

## 6. 数据模型

所有持久化表都必须使用 `org_id` 进行组织隔离。能够建立关系型外键的关联表必须使用包含 `org_id` 的复合键，防止同 ID 跨组织引用。目录策略和 ACL 等 polymorphic subject 无法使用单一外键时，写服务必须在同一事务中锁定并验证真实用户、组织节点或权限组；不得只校验字符串格式。

### 6.1 内部用户

```text
organization_users
- org_id                text
- principal_id          text
- email                 text nullable
- display_name          text
- status                invited | active | suspended | deprovisioned
- session_version       bigint
- created_at            bigint
- updated_at            bigint
- last_login_at         bigint nullable
- created_by            text
- updated_by            text

primary key (org_id, principal_id)
```

约束和索引：

- `display_name` 去除控制字符并限制长度。
- email 规范化为小写；必须建立 `unique (org_id, lower(email)) where email is not null`，因为邀请激活按 email 精确匹配，组织内重复 email 会使绑定结果不确定。
- `status`、`last_login_at` 和 `updated_at` 建立管理查询所需索引。
- `session_version` 在用户停用、恢复或敏感身份变更时递增。

### 6.2 OIDC 身份绑定

```text
auth_identities
- org_id          text
- issuer          text
- subject         text
- principal_id    text
- email_at_link   text nullable
- created_at      bigint
- updated_at      bigint

primary key (org_id, issuer, subject)
foreign key (org_id, principal_id)
  references organization_users(org_id, principal_id)
```

OIDC `issuer + subject` 是稳定登录身份，email 只用于资料和搜索，不能作为永久身份依据。

### 6.3 组织树

```text
org_units
- org_id          text
- id              text
- parent_id       text nullable
- name            text
- kind            organization | department | team
- status          active | archived
- sort_order      integer
- created_at      bigint
- updated_at      bigint
- created_by      text
- updated_by      text

primary key (org_id, id)
foreign key (org_id, parent_id)
  references org_units(org_id, id)
```

必须保证：

- 每个组织恰好一个 active 根节点。
- 根节点的 `parent_id` 为 null。
- 非根节点的 parent 与自身属于同一组织。
- 禁止把节点移动到自身或后代。
- 根节点不能删除或归档。
- 非根节点存在 active 子节点、active 成员、目录可见 root 或 Skill grant 引用时，归档返回 `409` 和影响摘要；管理员必须先移动成员/子节点并移除或替换引用。
- 节点归档不级联删除，也不能依赖解析器忽略残留引用。
- 节点移动、闭包更新、授权版本递增和审计写入必须在同一事务完成。

组织树查询建议使用闭包表：

```text
org_unit_closure
- org_id          text
- ancestor_id     text
- descendant_id   text
- depth           integer

primary key (org_id, ancestor_id, descendant_id)
foreign key (org_id, ancestor_id)
  references org_units(org_id, id)
foreign key (org_id, descendant_id)
  references org_units(org_id, id)
```

每个节点必须存在 `ancestor_id = descendant_id, depth = 0` 的自关联行。闭包表是从 `org_units.parent_id` 派生的查询索引，必须与节点变更同事务维护。

关键索引：

```text
org_units(org_id, parent_id, status, sort_order)
org_unit_closure(org_id, descendant_id, ancestor_id)
org_unit_closure(org_id, ancestor_id, depth, descendant_id)
```

### 6.4 组织成员关系

```text
org_unit_members
- org_id          text
- unit_id         text
- principal_id    text
- role            member | manager
- created_at      bigint
- created_by      text

primary key (org_id, unit_id, principal_id)
foreign key (org_id, unit_id)
  references org_units(org_id, id)
foreign key (org_id, principal_id)
  references organization_users(org_id, principal_id)
```

用户的有效组织节点为其直接节点以及这些节点的全部祖先节点。直接在节点上拥有 `manager` 角色的用户可以管理该节点及其后代的成员关系，但首期不能移动、归档组织节点，不能修改目录可见策略，也不自动获得 Skill 管理权。组织树结构和目录策略仍由组织管理员管理。

节点 manager 只能添加或移除 `member`，不能授予或撤销任何 `manager` 角色。manager 角色只由组织管理员维护，防止委派管理员横向扩权或继续转授。

### 6.5 权限组

```text
access_groups
- org_id          text
- id              text
- name            text
- status          active | archived
- created_at      bigint
- updated_at      bigint
- created_by      text
- updated_by      text

primary key (org_id, id)
```

```text
access_group_members
- org_id          text
- group_id        text
- principal_id    text
- role            member | manager
- created_at      bigint
- created_by      text

primary key (org_id, group_id, principal_id)
foreign key (org_id, group_id)
  references access_groups(org_id, id)
foreign key (org_id, principal_id)
  references organization_users(org_id, principal_id)
```

权限组不允许嵌套。归档权限组前必须检查目录策略、Skill grants 和其他有效引用；存在引用时返回 `409` 和影响摘要，管理员必须先显式移除或替换引用。归档操作不会静默保留可恢复的有效授权，也不会依赖解析器忽略残留 grant。

权限组 `manager` 只能维护本组直接成员，不能修改组织树、目录可见策略或任何 Skill Access。归档和恢复权限组由组织管理员执行。

权限组 manager 只能添加或移除 `member`，不能授予或撤销 manager 角色。manager 角色只由组织管理员维护。

### 6.6 目录可见策略

```text
directory_view_policies
- id              text
- org_id          text
- subject_kind    user | org_unit | access_group
- subject_id      text
- mode            all | limited | none
- revision        bigint
- created_at      bigint
- updated_at      bigint
- updated_by      text

primary key (org_id, id)
unique (org_id, subject_kind, subject_id)
```

```text
directory_view_roots
- org_id              text
- policy_id           text
- unit_id             text
- include_descendants boolean

primary key (org_id, policy_id, unit_id)
foreign key (org_id, policy_id)
  references directory_view_policies(org_id, id)
foreign key (org_id, unit_id)
  references org_units(org_id, id)
```

`limited` 可以有任意数量的 root。多个 root 取并集。root 重叠时服务端归一化结果，父节点已经包含后代时不重复返回后代成员。

`limited` 的 root 为空时结果为空。它不会回退到组织默认值。

### 6.7 Skill 组织归属和管理者

现有 Skill 记录只有 `scopeId` 和 `createdBy` 等字段，没有显式 `orgId`。目标 Skill model 必须增加不可为空的 `orgId`，并在创建、读取、移动、发布和授权时验证它；不能只从 `scopeId` 字符串推断组织归属。

首期 Skill manager 的权威来源固定为：

- Skill 记录中的 `createdBy`，且该用户仍是同组织 active 用户。
- 当前组织的组织管理员。

共享 home 的其他成员可以按 `home` mode 使用 Skill，但不再因为属于共享范围就自动获得编辑或转授权权限。以后如需委派管理，再增加显式 Skill manager binding，不复用 use grant。

### 6.8 Skill 访问策略

Skill 当前存储在通用 durable artifact map 中，因此访问策略使用独立关系表，以 Skill ID 和 owner scope 关联，不声明无法成立的关系型外键：

```text
skill_access_policies
- org_id          text
- skill_id        text
- owner_scope_id  text
- mode            home | organization | restricted
- revision        bigint
- created_at      bigint
- updated_at      bigint
- updated_by      text

primary key (org_id, skill_id)
```

三种模式：

| 模式 | 含义 | 额外授权对象 |
| --- | --- | --- |
| `home` | 沿用 Skill 当前 home scope 的自然受众；个人 home 为本人，共享 home 为当前有效成员 | 不允许 |
| `organization` | 当前组织全部 active 用户 | 不允许 |
| `restricted` | 仅命中选中主体的 active 用户 | 允许复选 |

`home` 用于保持现有 Skill 行为和安全迁移。管理权与使用权仍然分离；在 `restricted` 模式下，Skill manager 不因能够管理访问策略而自动拥有运行权限。

授权目标首期必须是 active 用户、active 组织节点或 active 权限组。系统不对 invited 用户预授权；用户完成激活后再由管理员或 Skill manager 显式加入，避免邀请被取消后残留潜在权限。

### 6.9 Skill 授权边

复用 `acl_grants`，但必须增加组织隔离和时间字段：

```text
acl_grants
- org_id
- owner_scope_id
- path
- grantee_scope_id
- permission
- granted_by
- granted_at

primary key (
  org_id,
  owner_scope_id,
  path,
  grantee_scope_id,
  permission
)
```

Skill 授权固定为：

```text
path       = skill:<skillId>
permission = read

grantee_scope_id =
  personal:<principalId>
  org-unit:<unitId>
  access-group:<groupId>
```

首期 API 和业务层把 Skill 的 `read` 解释为 `use`，不向页面暴露底层名称。Skill Access API 只允许写入 `read`；SkillAccessResolver 忽略 `skill:*` 上的 `write`。迁移报告必须列出历史 `write` grant，管理员确认后删除或转换，不能把它解释为编辑权，也不能让它参与使用权计算。其他资源类型现有的 `write` 语义不受影响。

`home` 和 `organization` 模式不允许保留任何 `skill:*` ACL grant；切换到这两种模式时必须在同一事务清除该 Skill 的全部 `read/write` grants 并记录审计。`restricted` 模式只允许 `read` grants。从 `restricted` 切换到空列表时，模式保持 `restricted`，结果为无人可用。读取时如发现模式和 grants 不满足这些不变量，必须 fail closed 并产生运维告警，不能自行猜测权限。

### 6.10 组织授权版本

```text
organization_authz_state
- org_id          text primary key
- revision        bigint
- skill_access_policy_version integer
- skill_access_enforced_at bigint nullable
- updated_at      bigint
```

以下变化必须与 revision 递增在同一数据库事务中完成：

- 用户状态和 session version 变化。
- 组织节点新增、移动、归档。
- 组织节点成员变化。
- 权限组及其成员变化。
- 目录可见策略变化。
- Skill access mode 或 grants 变化。
- Skill 创建、内容或附件更新、发布、归档、恢复和删除。
- Skill home scope 移动、promote 和 owner/manager 变化。
- Skill Pack import/sync/remove、deployment layer/seed Skill 写入和自动同步。
- 管理员和 Skill manager 变化。

组织本身是部署配置而非 API 资源：当前部署为单组织（`ORG_ID` 配置，无 organizations 表）。首次启动时必须在同一事务中创建该组织的根节点和 `organization_authz_state` 行；`skill_access_enforced_at` 在 18.4 的 cutover 时设置。

授权相关写入仅指 Skill 内容、附件、状态、scope、owner/manager 和访问策略。执行期统计元数据（如 `lastUsedAt`）不属于授权相关写入：不递增 revision、不参与 content hash、不要求 SkillAccessRepository 事务，避免每次 Skill 执行使全部实例的 snapshot 与缓存失效。

Postgres notification 可以用于主动清除缓存，但不能作为正确性的唯一来源。

## 7. 登录与身份流程

### 7.1 登录准入模式

组织可配置以下准入策略：

```text
invite_only      只有已存在的 invited/active 用户可以完成登录
domain_auto_join 受信邮箱域首次登录时创建 active 用户
```

权限要求较高的部署建议使用 `invite_only`。

### 7.2 登录流程

```text
1. Portal 完成 OIDC 校验。
2. 使用可信 issuer + subject 查询 auth_identities。
3. 校验映射到的 organization_users 属于当前 org。
4. 按准入策略进入受控激活或拒绝未知身份。
5. invited 用户完成激活前不签发标准业务会话。
6. 拒绝 suspended 和 deprovisioned 用户。
7. 更新 display_name、email 和 last_login_at。
8. 只为 active 用户签发包含身份与 session version 的 Portal 会话。
9. Core 每个受保护请求重新确认 active 状态和 session version。
```

浏览器、Portal 或外部 connector 提交的 `teamIds`、组 ID 或用户状态一律不能作为授权事实。

invited 用户的激活不设独立令牌接口：首次 OIDC 登录时，Portal 调用 11.5 的 login 接口，服务端按组织内唯一的 verified email 精确匹配 invited 记录（IdP 必须返回 `email_verified=true`），一次性绑定 issuer+subject 并把状态置为 active，写审计；email 未验证或匹配不到时拒绝。预绑定了 issuer+subject 的邀请只允许该身份激活，防止同 email 的其他 IdP 账户接管邀请。

人类 Portal 用户与 source-auth 服务身份必须分开。连接器和后台服务不能通过伪造 `organization_users` 记录获得人类权限。

## 8. 组织目录可见性

### 8.1 默认规则

组织默认目录模式为 `all`，所以没有覆盖策略的 active 用户可以查看整个组织。

组织管理员始终可以查看全组织。普通用户按以下顺序解析：

```text
1. 存在用户个人策略：完整使用个人策略，忽略组织节点和权限组策略。
2. 不存在个人策略：收集用户有效组织节点及权限组上的策略。
3. 没有任何策略：使用组织默认模式，默认 all。
4. 任一组策略为 all：结果为全组织。
5. 否则合并全部 limited roots。
6. 只有 none 或 limited roots 为空：结果为空。
```

个人策略完整覆盖组策略可以避免多组关系意外扩大某个敏感用户的可见范围。需要为某人增加其他组时，管理员建立个人 `limited` 策略，并在复选器中同时选择原范围和额外范围。

### 8.2 复选语义

例如用户可以同时选择：

```text
☑ 研发部，包含下级
☑ 财务部 / 预算组，仅当前节点
☑ 华东销售部，包含下级
```

最终范围为三项并集。用户属于多个可见组织节点时只返回一次。

### 8.3 树返回规则

全组织模式返回完整 active 组织树。

受限模式只返回：

- 选中的可见根节点。
- `include_descendants=true` 时的 active 后代。
- `include_descendants=false` 时的当前节点。
- 这些范围内的可见 active 用户。

不返回隐藏兄弟节点、隐藏成员数、隐藏子节点数或全局总数。前端可以把多个允许根显示在一个“可见组织”虚拟根下，避免为拼接完整路径泄漏隐藏结构。

`/v1/me` 只允许 active 用户调用，并且可以返回该用户自己的最小资料；`none` 目录策略不代表 active 用户看不到自己的登录资料。invited 用户只能走 7.2 的受控激活完成首登，不能调用任何业务接口。

### 8.4 搜索与分页

服务端查询顺序必须是：

```text
组织隔离
→ active 状态
→ 目录可见范围
→ 搜索条件
→ 排序
→ 计数
→ 游标分页
```

禁止先查询全组织，再由前端过滤。搜索结果、总数、分页游标和响应时间都不能泄漏隐藏人员。

## 9. Skill 多选访问控制

### 9.1 页面模式

Skill 创建或详情页增加独立的“访问范围”区域：

```text
访问范围

○ 所属范围
  个人 Skill 表示仅本人；共享 Skill 表示当前共享范围成员

○ 全组织
  当前组织所有 active 用户

○ 受限范围
  组织节点：研发部、财务部 / 预算组
  权限组：AI 高级用户、数据委员会
  指定人员：张三、李四
```

`受限范围`使用三个可搜索的多选面板：

- 组织节点。
- 权限组。
- 指定人员。

选择结果以 chips 展示，可以跨面板复选、删除和搜索。页面必须明确显示“满足任意一个选项即可获得单人使用权”。

组织节点授权默认包含其全部后代。需要精确、跨部门或排除个别人员时，使用独立权限组表达。

创建页现有的“Available to”下拉框保留为 home scope 选择器，语义不变，普通用户与管理员使用同一创建页。“访问范围”是独立区域：创建时固定写入 `mode=home`，创建后由 Skill manager 或组织管理员调整。非组织管理员的访问范围控件不提供“全组织”选项（与 9.5 一致）；选择器候选和手工提交都受 9.5 的可见性约束。

### 9.2 单人使用权

```text
canUseSkill(user, skill) =
  user 属于 skill.org
  AND user.status = active
  AND skill.status = published
  AND modeMatches(user, skill)
```

模式判断：

```text
home:
  用户对 Skill home scope 具有自然读取资格

organization:
  用户是当前组织 active 用户

restricted:
  personal:user 命中
  OR 用户属于选中的 access-group
  OR 用户直接节点或祖先节点命中选中的 org-unit
```

多个受限主体取并集。指定人员授权独立于该人员后来所属的组织节点；只有撤销直接授权、停用用户或删除用户时才失效。

### 9.3 多人会话

组织节点、权限组和人员的复选是单人授权并集。共享会话还必须计算完整受众交集：

```text
canUseSkillForAudience(skill, audience) =
  audience 非空
  AND audience 可以完整、权威地解析
  AND audience 中每个用户都是 active internal 用户
  AND audience 中每个用户都满足 canUseSkill
```

因此，只要项目、频道或群组中的一个当前成员无权使用某 Skill，该 Skill 就不能进入 Prompt 或 Sandbox。

项目 audience 必须使用当前 active 项目成员，不使用项目创建时快照。目录可见范围不会从 audience 中移除隐藏成员；隐藏成员仍然可能阻止 Skill 在多人上下文中加载。

权威 audience 来源固定为：

- DM、个人 Web 会话：当前 active actor。
- 项目：当前 active 项目成员。
- 私有频道或群组：执行时从权威 membership store 读取完整当前成员；guest 仍保留在 audience 并使内部 Skill 不可用。
- 公开频道：必须解析完整当前受众；无法权威枚举时拒绝使用任何内部 Skill。组织外用户或 guest 必须保留在 audience 并使内部 Skill 不可用。
- 直接收件人、其他用户 DM 或外部地址：active `runAs` 与全部实际收件人共同组成 audience；任何收件人无法映射为同组织 active 内部用户时，内部 Skill 不可用。
- Cron/Trigger 无共享投递目标：active `runAs` principal。
- Cron/Trigger 投递到项目、频道、群组或直接收件人：active `runAs` 加全部当前投递受众，去重后共同校验。
- 组织广播：当前组织全部 active 用户；存在 guest 或外部收件人时内部 Skill 不可用。

上述规则适用于 `home`、`organization` 和 `restricted` 全部模式。任何模式只要无法完整、权威地解析 audience，就必须 fail closed。

这一语义的产品后果需要明确接受：restricted Skill 在成员众多的频道里实际上很难可用，含 guest 或外部收件人的上下文中 `organization` Skill 也不可用。这是 fail closed 的预期行为，不是缺陷。

频道和群组的成员关系首期以内部 membership store（由目录同步供给）为准。关键在于 audience 与实际投递收件人必须取自同一份成员快照：快照延迟导致已移除成员仍留在 audience 时，结果是多校验人而拒绝，方向安全；尚未同步进快照的成员也不会收到投递，不会成为漏校验的收件人。任何投递路径如果可以不经过该快照枚举收件人，就不能用于受权限控制的 Skill 输出。

### 9.4 同名 Skill 和 Scope 优先级

必须先做授权过滤，再应用现有 scope precedence 和同名 shadow 规则。

无权使用的更窄 Scope Skill 不能遮蔽用户有权使用的更宽 Scope 同名 Skill。

### 9.5 Skill 管理权

| 能力 | 组织管理员 | Skill manager | 组织节点管理员 | 权限组管理员 | 普通使用者 |
| --- | --- | --- | --- | --- | --- |
| 使用已授权 Skill | 是 | 仅在有使用权时 | 仅在有使用权时 | 仅在有使用权时 | 是 |
| 修改 Skill 内容 | 是 | 是 | 否 | 否 | 否 |
| 设置受限访问对象 | 是 | 是，但只能选择其可见且同组织的对象 | 否 | 否 | 否 |
| 设置全组织访问 | 是 | 否 | 否 | 否 | 否 |
| 转授 Skill 管理权 | 是 | 首期不支持 | 否 | 否 | 否 |

管理某个组织节点或权限组不代表可以把任意 Skill 授给该组。只有 Skill manager 或组织管理员能修改 Skill 访问策略。

Skill manager 只能选择其目录可见范围内的目标。如果目录策略变化后，已有 Skill grant 指向其不可见对象，GET Access 只返回可见对象和 `hiddenSubjectCount`，不返回隐藏对象 ID、名称或类型；同时标记 `editable=false`。Skill manager 不能提交可能静默删除隐藏 grant 的全量替换，必须由组织管理员处理。组织管理员可以查看和修改完整策略。

“看得见组织节点名称”不足以授权该节点。非组织管理员选择 `org_unit` 时，必须能看见该节点授权将覆盖的全部 active 后代成员；选择 `access_group` 时，必须能看见该组全部 active 成员。否则目标不出现在选择器中，手工提交返回 `404`，也不返回可能泄漏隐藏人数的 effectiveSummary。组织管理员不受此目录范围限制，但仍受同组织和 active 状态约束。

## 10. 统一授权服务

新增两个服务端解析器：

```text
DirectoryVisibilityResolver
SkillAccessResolver
```

它们依赖：

- 内部用户和状态。
- 组织树及闭包。
- 组织节点成员关系。
- 权限组成员关系。
- 目录可见策略。
- Skill 访问策略和 ACL grants。
- 当前 `organization_authz_state.revision`。

`SkillStore.visibleFor` 和 Skill materializer 可以保留为无权限的底层原语，但任何请求或执行路径不得直接把它们当授权结果。生产 materializer 调用只接受 SkillAccessResolver 产生并绑定 org、audience、revision 和 content hash 的授权 snapshot；脚本和测试工具不能成为生产旁路。

生产 Postgres 中的 Skill 仍存放在通用 `skills(id, json)` durable map，而 policy、ACL、revision 和 audit 是关系数据。必须新增拥有同一数据库事务的 `SkillAccessRepository`，但 Repository 不能自行拼装或直接改写 Skill JSON。实现时先把 Skill 名称校验、签名、审批和状态转换抽取为可复用的纯 domain transition；事务 Repository 调用这些规则后，使用同一个 `PoolClient` 锁定并持久化 Skill、policy、grants、revision 和 audit。

Skill 行写入还必须在同一事务递增 `durable_map_versions` 中 `skills` 的版本，使其他实例的 DurableMap 缓存失效；或者将全部 Skill 读取统一迁移到同一个无旧缓存旁路的 Repository。不得直接 SQL 更新 `skills` 而遗漏 cache version，也不能由应用服务依次调用彼此独立提交的 `SkillStore.put`、`AclStore.replace` 和 `audit.record`。内存开发存储必须以同一个互斥区复用相同 domain transition 并模拟原子边界。

### 10.1 必须接入 DirectoryVisibilityResolver 的路径

- 组织树。
- 组织节点详情。
- 用户搜索与自动补全。
- 用户详情。
- 组织节点和权限组成员列表。
- 项目添加成员候选。
- Skill Access 目标选择器。
- 管理页面中的非管理员受限视图。

### 10.2 必须接入 SkillAccessResolver 的路径

- Skill 列表、搜索和自动补全。
- Skill 详情、正文和附件。
- Scope Resources 聚合页中的 Skill 元数据和计数。
- Admin Skill 列表、详情、计数和管理读取。
- Share、move、promote 的 artifact home 与存在性前置查询。
- Agent Prompt 构建。
- Sandbox 初始物化。
- Sandbox 复用和延迟读取，包括 Sandbox 内命令和文件读取触发的 `skills/<name>/` 延迟物化（[`src/tools/primitives.ts`](../src/tools/primitives.ts) 的 ensureSkillTree），这是绝对路径和 shell 间接调用的入口。
- Skill 真正执行前。
- Cron、Trigger 和后台恢复任务。
- 项目、频道、群组、DM 和 Web 会话。
- Skill archive/restore 后的重新解析。
- Onboarding prompt 的可见 Skill 门控（[`src/onboarding/onboarding.ts`](../src/onboarding/onboarding.ts)）。
- Agent API catalog 的 Skill CRUD 与 auto-load 文案（[`src/api/agent-api-catalog.ts`](../src/api/agent-api-catalog.ts)）。
- Admin 按 scope 的 Skill 计数（[`src/api/routes/admin/scope-config.ts`](../src/api/routes/admin/scope-config.ts)）。
- Web composer 的 slash 自动补全（经 web-ui server 代理 `/api/skills`）。

无法确认身份、成员关系、完整 audience、授权版本或数据库状态时必须 fail closed，不能回退到 org scope、home scope 或最近一次缓存结果。

Scope Resources 必须按当前 actor 的使用权过滤。Admin 例外必须通过显式组织管理员或 Skill manager 权限调用管理视图，不能直接 `listSkills/getSkill`。Share、move、promote 必须先经管理权限解析；无权对象统一返回 `404`，不能在授权前暴露 Skill 是否存在、home scope、owner 或其他元数据。

### 10.3 Turn 授权快照和运行时撤权

每个 Agent turn 必须在进入模型前创建不可变授权快照：

```text
org_id
organization_authz_revision
authoritative audience ids + status/session versions
session/project scope id + membership version
authorized skill ids + skill versions + policy revisions
authorized skill content hashes
snapshot id / created_at
```

Prompt、Skill 文件树、Sandbox materialization 和工具 preflight 必须使用同一个 snapshot，不能分别查询后得到不同结果。snapshot 只对当前 turn 有效，不能跨 audience 或 revision 复用。

以下检查点都必须确认数据库 revision 仍与 snapshot 一致：

- 模型输入前和最终输出交付前。
- 每次 Skill 文件打开或延迟读取前。
- 每次工具调用、进程启动、恢复、重连和后台任务继续前。
- owner-auth、reach、scratch、global/team scope、fallback mount 和非本地执行路径。
- Sandbox 复用、文件树缓存和 `laidTrees` 命中前。

revision 变化时立即使当前 turn 失效，停止继续向模型或用户交付结果，并终止该 turn 启动的进程和后台任务。系统不得自动重放整个 turn；用户或调度器必须发起新请求。只有具备覆盖整个 turn 的持久化幂等键和所有外部副作用去重协议时，才允许受控自动重试。已经完成的不可逆外部副作用不能回滚，但必须审计。

Sandbox 必须绑定 `org_id + audience_hash + authz_revision + skill content hashes`。授权变化后不得只更新 Skill 索引；必须删除所有旧 Skill mount、global/team tree、fallback tree 和物化文件。因为 Skill 内容可能已经复制到 scratch、通过绝对路径/符号链接访问或被长驻进程读入内存，不能证明清理完整时必须销毁 Sandbox 并终止相关进程。清理或销毁失败时拒绝继续执行。

任何本地或非本地执行后端如果无法实现上述 preflight、进程终止和 Sandbox 隔离契约，就不能执行受权限控制的 Skill。不得保留“非本地执行跳过 Skill preflight”的兼容路径。

### 10.4 Skill 生命周期写入

以下入口必须调用同一 SkillAccessRepository 事务边界，不能直接写 SkillStore 或 ACL：

- Skill create、content/assets update、publish、archive、restore 和 delete。
- Skill move、promote、share 和 unshare。
- Skill Pack import、sync 和 remove。
- deployment layer、seed、plugin-installed Skill 和自动同步写入。
- Admin、Web、Agent API 和内部 source-auth 对应入口。

每次写入必须原子维护 Skill `orgId`、`scopeId`、content/version、access policy、相关 grants、组织授权 revision 和审计。Pack 或 deployment layer 批量写入要么在有界单事务中全部完成，要么按每个 Skill 独立事务并返回明确的部分结果；任何单个 Skill 都不能出现 artifact 已变化而 policy/revision 未变化的状态。

## 11. API 设计

所有用户身份从签名 Portal 身份或能力令牌中取得。公开 API 不接受请求体或 query 中的任意 `principalId` 作为授权事实。

### 11.1 当前用户

```text
GET /v1/me
```

仅 active 用户可调用。返回当前用户资料、状态、直接组织节点、权限组和授权版本。普通用户不能从该接口枚举其他成员。目录策略为 `none` 的 active 用户仍可读取自己的最小资料，这只是个人资料例外，不代表能够读取组织目录。

### 11.2 组织目录

```text
GET /v1/org/tree
GET /v1/org/units/:id
GET /v1/org/users?q=&unitId=&cursor=&limit=
GET /v1/org/access-groups?q=&cursor=&limit=
GET /v1/org/access-groups/:id/members
```

所有结果都受 DirectoryVisibilityResolver 限制。客户端提供的 `unitId` 只是进一步收窄条件，不能扩大服务端计算的可见范围。

### 11.3 组织管理

```text
POST   /v1/admin/org/users          邀请用户：创建 invited 记录（email 必填，可选预绑定 issuer+subject）
POST   /v1/admin/org/units
PATCH  /v1/admin/org/units/:id
POST   /v1/admin/org/units/:id/members
DELETE /v1/admin/org/units/:id/members/:principalId

POST   /v1/admin/org/access-groups
PATCH  /v1/admin/org/access-groups/:id
POST   /v1/admin/org/access-groups/:id/members
DELETE /v1/admin/org/access-groups/:id/members/:principalId

PATCH  /v1/admin/org/users/:principalId
PUT    /v1/admin/org/directory-visibility/:subjectKind/:subjectId
```

上述成员管理路由按角色放行：组织管理员可执行全部操作；组织节点 manager 只能在自己管理的子树内增删 `member` 角色成员；权限组 manager 只能维护本组 `member` 角色成员。manager 不能授予或撤销任何 manager 角色（与 6.4、6.5 一致），跨组织或不可见对象统一返回 `404`。用户邀请、状态修改、目录策略和组织树结构操作仅组织管理员可用。

目录策略更新示例：

```json
{
  "mode": "limited",
  "roots": [
    { "unitId": "engineering", "includeDescendants": true },
    { "unitId": "finance-budget", "includeDescendants": false }
  ],
  "expectedRevision": 7
}
```

`roots` 是完整替换，不是增量补丁。服务端归一化、去重并验证每个节点同组织且 active。revision 不匹配返回 `409` 和当前 revision。

首期只有组织管理员可以修改目录可见策略。以后增加委派管理员时，其操作范围必须限制在被授权子树内。

### 11.4 Skill Access

```text
GET /v1/skills/:id/access
PUT /v1/skills/:id/access
```

受限多选请求示例：

```json
{
  "mode": "restricted",
  "subjects": [
    { "kind": "org_unit", "id": "engineering" },
    { "kind": "org_unit", "id": "finance-budget" },
    { "kind": "access_group", "id": "ai-power-users" },
    { "kind": "user", "id": "principal-123" },
    { "kind": "user", "id": "principal-456" }
  ],
  "expectedRevision": 11
}
```

返回示例：

```json
{
  "mode": "restricted",
  "subjects": [
    { "kind": "org_unit", "id": "engineering", "name": "研发部" },
    { "kind": "access_group", "id": "ai-power-users", "name": "AI 高级用户" },
    { "kind": "user", "id": "principal-123", "name": "张三" }
  ],
  "effectiveSummary": {
    "activeUsers": 42,
    "orgUnits": 2,
    "accessGroups": 1,
    "directUsers": 2
  },
  "revision": 12
}
```

`effectiveSummary` 只用于管理预览，不能由客户端用于授权判断。

PUT 必须在单一事务中完成：

```text
锁定 Skill policy 和组织授权 revision
→ 校验 expectedRevision
→ 校验操作者管理权
→ 校验 Skill、主体和操作者属于同一组织
→ 校验授权目标 active 且对操作者可见
→ 校验当前策略不存在操作者不可见的隐藏主体
→ 替换 policy 和 grants
→ 递增组织授权 revision
→ 写入审计
→ 提交
```

`home` 和 `organization` 要求 `subjects` 为空。`restricted` 允许空数组，空数组表示无人可用。

授权 active-only 是有意限制：invited 用户不会出现在候选列表，手工提交 invited、suspended 或 deprovisioned principal 返回 `404`。

现有通用 `/v1/grants`、`/v1/grants/revoke` 和 agent `share` 路径不得继续直接修改 `skill:*` grant：

- 通用 grant/revoke API 对 `skill:*` 返回明确的 `409 skill_access_required`。
- Agent 的 Skill share/unshare 改为调用 SkillAccessRepository 的目标增删事务。
- Agent 目标增删同样验证 manager、同组织、目标可见性、policy mode，递增 revision 并写审计。
- 对非 Skill 资源，现有通用 grant 行为保持不变。

Skill 创建必须在同一事务写入 Skill 记录和 `mode=home` policy。Skill move/promote 必须在同一事务更新 `scopeId`、policy `owner_scope_id`、相关 ACL owner key、revision 和审计。移动到更宽 home 不能隐式扩大访问；请求必须同时提交明确 access mode，移动到组织范围时必须由组织管理员确认。归档、恢复、发布和删除也必须递增组织授权 revision。

### 11.5 Portal 内部用户注册

```text
POST /v1/internal/auth/users/login
```

该接口只允许受信 Portal source-auth 调用，用于幂等绑定 OIDC identity、检查准入策略、更新用户资料和 last login。浏览器不能直接调用。

## 12. UI 设计

### 12.1 组织管理页

页面采用左侧树、右侧详情：

```text
组织架构                       节点详情
☰ 公司                         名称：公司
  ▾ 研发部                     类型：部门
    · 平台组                   成员：18
    · 应用组                   管理员：2
  ▾ 财务部
    · 核算组
    · 预算组
```

支持：

- 新建、改名、移动和归档节点。
- 成员搜索、批量加入和移除。
- 节点移动前显示权限影响预览。
- 禁止拖到自身或后代。
- 隐藏节点和人数绝不由前端过滤。

### 12.2 用户目录可见范围页

为用户、组织节点或权限组设置策略：

```text
目录可见范围

○ 使用默认规则：全组织
○ 全组织
○ 受限范围
  ☑ 研发部                 [包含下级]
  ☑ 财务部 / 预算组        [仅当前节点]
  ☑ 华东销售部             [包含下级]
○ 不可查看组织目录

当前有效范围：3 个根节点，预计 64 位 active 用户
```

受限范围必须支持复选和搜索。切换为 `limited` 后即使没有选择任何节点，也要明确显示“该用户看不到任何组织成员”，不能静默恢复默认全组织。

### 12.3 Skill Access 页

Skill 的发布状态、能力审批和访问范围分开显示。访问卡片包括：

- 当前模式。
- 多选主体 chips。
- 服务端计算的有效用户数量。
- 最近修改人、时间和 revision。
- 管理访问入口。
- 审计入口。

普通 use 用户只看到“你可以使用此 Skill”，不能查看完整授权名单。Skill manager 可以读取其目录可见范围内的授权明细；存在隐藏授权对象时页面显示数量并锁定编辑。组织管理员可以读取完整授权明细。

Skill Pack 的“安装到 Scope”与 Access 授权必须使用不同页面和文案。前者可能创建或同步副本，后者是同一 Skill 的使用权限。

### 12.4 错误与防枚举

- 不可见对象统一返回 `404`。
- 对象已可见但操作权限不足时返回 `403`。
- 并发 revision 冲突返回 `409` 并提示重新加载。
- 目录未配置、没有匹配结果、没有查看权限必须使用不同文案。
- 搜索输入使用防抖和最小长度，但服务端仍必须限流和限制结果数。

## 13. 项目集成

项目成员选择器改为查询内部 `/v1/org/users`，只返回：

- 与操作者同组织。
- 状态为 active。
- 位于操作者目录可见范围内。
- 尚未加入当前项目的用户。

客户端提交成员 ID 后，服务端必须重新执行同样的可见性和状态校验，不能相信搜索结果缓存。

建议把项目成员管理权限收紧为项目 owner/manager 或组织管理员。当前项目中的任意普通成员不应默认获得添加其他成员的权限。

项目内执行 Skill 时，授权 audience 是当前 active 项目成员集合，而不是发起人个人或其可见成员集合。

## 14. 缓存、撤权和多实例一致性

缓存键至少包含：

```text
org_id
principal_id 或 audience_hash
resource_id
organization_authz_state.revision
skill.version / skill content hash
skill_access_policies.revision
```

每个受保护 HTTP 请求和 Agent turn 必须从持久化存储确认当前 revision。数据库或 revision 不可用时 fail closed。

revision 确认允许以数据库为权威的短 TTL（秒级）读缓存，并用 Postgres NOTIFY 加速失效；TTL 到期或通知到达后必须回读数据库，NOTIFY 和进程内状态永远不能单独作为权威。批量操作（成员导入、Pack 同步、seed/deployment 写入）整个事务只递增一次 revision，避免单行计数器成为写热点。

撤权生效边界：

- 新 HTTP 请求立即失效。
- 正在执行的 Agent turn 在下一个 preflight 或最终输出交付前失效并终止。
- 下一轮 Agent turn 使用新 snapshot。
- 下一次 Skill 物化、延迟读取、工具调用、进程恢复或后台任务继续前立即失效。
- 复用 Sandbox 时重新解析；无法证明旧 Skill、fallback mount、scratch 副本和进程已完整清除时销毁 Sandbox。
- 已经完成的外部副作用无法回滚，但必须保留审计。

纯进程内 Map、Cookie claim 或长 TTL 缓存不能成为授权权威。Postgres NOTIFY 只能加速失效，不能代替 revision 校验。

## 15. 安全要求

### 15.1 Fail closed

以下情况全部拒绝：

- principal 未在内部用户表中找到。
- 用户不是 active。
- 组成员关系或组织树无法确认。
- 树出现循环或跨组织 parent。
- Skill policy、ACL 或授权 revision 读取失败。
- audience 为空或无法完整解析。
- 请求携带隐藏对象或其他组织对象 ID。
- 缓存 revision 与数据库不一致。

禁止回退为：

- 全组织目录可见。
- Skill home 或 org scope 全员可用。
- 最近一次缓存授权。
- 未知用户视为 internal。

### 15.2 组织隔离

- 所有查询必须携带 `org_id`。
- 能建立关系型关联的表使用同组织复合外键；polymorphic subject 在同一事务锁定并验证真实对象。
- 授权写入前验证 actor、resource、subject 同组织。
- 不能把 scope 字符串格式当成组织归属证明。
- 跨组织 ID 对无权调用者返回 `404` 并记录安全审计。

### 15.3 防枚举

以下数据都受目录可见性控制：

- 姓名、邮箱、头像、职位和上级。
- 组织节点名称、父子关系。
- 成员数、子节点数、搜索总数。
- Skill 名称、描述、owner 和授权对象。

过滤必须发生在 SQL 搜索、计数和分页之前。非管理者不能读取 Skill 的完整授权名单。

### 15.4 请求安全

- 写接口必须从签名身份解析 actor。
- 不接受客户端提供的 `grantedBy`、`updatedBy` 或任意 principal 作为事实。
- 浏览器写接口必须执行 CSRF、Origin 和 Content-Type 校验。
- 搜索与登录接口必须限流。
- 所有 SQL 使用参数化查询。
- 日志不记录 Token、Cookie、Skill 正文或不必要的个人资料。

## 16. 审计要求

复用现有 PostgreSQL `audit_log`，但权限变更需要提供事务内写入能力。当前异步 `record` 失败后只记录日志，不能满足“授权修改和审计必须同成同败”的要求。相关实现位于 [`src/admin/postgres-audit-log.ts`](../src/admin/postgres-audit-log.ts)。

目标 schema 需要在现有字段上增加 `org_id`、`actor_kind`、`request_id`、`before_digest`、`after_digest`、`source` 和 `result`，并提供接受现有 `PoolClient` 的事务内 insert 方法。事务内 insert 沿用现有 `recordOnce` 的 `idempotency_key` 做重试去重。用户、组织、目录策略和 Skill 权限修改只有在审计 insert 成功后才能提交；审计失败导致整个修改回滚。普通读取日志可以继续使用异步接口，但不能用于权限变更事务。

以下事件必须审计：

- 登录成功、拒绝以及停用用户尝试登录。
- 用户状态变化。
- 组织节点创建、移动、归档。
- 组织节点和权限组成员变化。
- 目录可见策略变化。
- Skill access mode、授权主体和 manager 变化。
- 跨组织 ID、隐藏对象 ID 和伪造主体等高风险拒绝。
- 后台任务因撤权被取消。

审计至少包含：

```text
org_id
actor principal 或 service id
action
resource type 和 id
before digest
after digest
request id
occurred_at
source
result
```

审计中不保存 OIDC Token、Cookie、Skill 正文或不必要的完整个人资料。

## 17. 并发与事务

目录策略和 Skill Access 更新使用全量替换与乐观并发：

- GET 返回资源 revision。
- PUT 必须携带 `expectedRevision`。
- 服务端在事务中锁定资源和组织授权状态。
- revision 不一致返回 `409`，不做部分写入。
- policy、roots/grants、组织 revision 和审计必须原子提交。

组织节点移动还必须原子更新：

- `org_units.parent_id`。
- `org_unit_closure`。
- 受影响节点 version。
- `organization_authz_state.revision`。
- 审计记录。

不允许先更新树再异步刷新权限索引。

## 18. 迁移策略

### 18.1 用户迁移

不能把历史 conversation participants 全部直接导入 active 用户，因为历史 principal 可能来自外部用户、Slack ID、旧邮箱或测试数据。

建议来源优先级：

1. 已验证的 OIDC `issuer + subject`。
2. 当前管理员明确确认的用户。
3. 配置中的受信登录 allowlist。
4. 外部目录中的 internal 用户，仅作为待审核导入候选。

### 18.2 组织迁移

每个现有组织创建一个根节点。未分组用户可以暂时只挂在根节点，之后由管理员批量移动到部门或团队。

Slack 用户组只能作为导入候选，不能持续覆盖内部组织节点和成员关系。

### 18.3 ACL 迁移

为 `acl_grants` 增加 `org_id` 时按以下顺序迁移：

1. Expand schema：增加 nullable `org_id` 和兼容索引，不改变旧读写。
2. 部署兼容版本：所有新 writer dual-write `org_id`，reader 仍能读取旧行。
3. 等待所有旧实例退出，确认没有仍会写 null 的进程。
4. 根据 owner scope、Skill `orgId` 和组织配置回填历史行。
5. 报告并隔离无法确定组织的数据，持续监测不再产生新 null。
6. 部署新 reader，所有查询显式使用 `org_id`，并验证新旧结果一致。
7. 建立包含 `org_id` 的复合唯一键和索引。
8. 最后将 `org_id` 改为 not null，删除兼容读路径和旧索引。

### 18.4 Skill 迁移

- 先为 Skill model 回填并验证不可为空的 `orgId`。
- 为每个现有 Skill 创建 `mode=home` policy，保持当前自然 scope 行为。
- 迁移期间只有 `skill_access_policy_version=0` 的组织允许 legacy reader 将已登记在迁移清单中的缺失 policy Skill 按 `home` 处理。
- Skill 创建从兼容版本开始必须与 policy 同事务写入，不允许产生新的缺失 policy。
- 验证 Skill 数量、policy 数量、owner scope 和 orgId 全部一致后，在事务中设置组织 cutover marker 和 `skill_access_policy_version=1`。
- cutover 后缺少 `orgId` 或 policy 必须 fail closed 并告警，不能永久回退为 `home`。
- 现有共享 home Skill 的 use 仍按 `home` 保留，但编辑/授权 manager 收紧为 active `createdBy` 和组织管理员；迁移报告必须列出 createdBy 缺失、非 active 或无法映射组织的 Skill，由组织管理员接管后才能编辑。
- 现有 `skill:*` ACL grants 当前可能已经存在但未实际生效。代码核实这些 grant 没有任何读取方（`grantsOfKind` 只用于 service-cred），因此迁移只需管理语义预期，不存在权限回退风险。
- 上线前生成 dry-run 报告，由管理员确认哪些旧 grants 转换为 `restricted`。
- 未确认的旧 grants 不自动激活，避免功能上线时意外扩大访问范围。

## 19. 实施分期

### 阶段一：内部用户和严格身份

- `organization_users`、`auth_identities` 和状态管理。
- Portal 登录 upsert 与 active 校验。
- 区分人类身份和 service/source-auth 身份。
- 未知人类 principal fail closed。

### 阶段二：组织树和权限组

- `org_units`、闭包表和成员关系。
- 权限组和成员管理。
- 管理 API 与 Admin UI。
- 节点移动、循环校验、事务和审计。

### 阶段三：目录可见范围

- DirectoryVisibilityResolver。
- 多根复选策略。
- 组织树、人员搜索和详情统一过滤。
- 项目成员选择器切换到内部目录。

### 阶段四：Skill Access 服务端

- `skill_access_policies`。
- `acl_grants.org_id` 迁移。
- SkillAccessResolver。
- 列表、详情、Prompt、Sandbox、Cron 和后台执行全部接入。
- 授权 revision、缓存失效和 Sandbox 清理。

### 阶段五：Skill Access UI

- Web Skill 创建和详情页 Access 控件。
- Admin Skill Access 卡片。
- 组织节点、权限组和人员多选器。
- 变更预览、CAS 冲突和审计展示。

## 20. 建议模块边界

实现时建议按职责组织，不把授权逻辑塞进纯存储层：

```text
src/organization/
  organization-store.ts
  postgres-organization-store.ts
  organization-service.ts

src/authorization/
  directory-visibility.ts
  skill-access.ts
  authorization-revision.ts

src/api/routes/
  organization.ts
  skill-access.ts

plugins/portal/
  登录身份绑定和状态校验

plugins/web-ui/
  项目成员选择器和 Skill Access 页面

plugins/admin/
  组织树、用户、权限组和管理授权页面
```

Store 负责持久化和事务原语；Resolver 负责权限计算；Route 只负责认证输入、调用服务和序列化结果。UI 不包含授权真相。

## 21. 测试计划

### 21.1 用户和身份

- invited、active、suspended、deprovisioned 的登录和请求行为。
- 未知 principal 拒绝。
- OIDC issuer+subject 绑定和 email 变化。
- session version 变化后旧会话失效。
- 人类与 service identity 不混用。
- invited 用户经 OIDC 首登按 verified email 一次性绑定 issuer+subject 激活；email 未验证、重复或匹配失败时拒绝。
- 主体非 active 时其组织管理员、节点 manager、权限组 manager 和 Skill manager 角色立即失效。

### 21.2 组织树

- 单根约束。
- 创建、移动和归档节点。
- 禁止 parent 指向自身或后代。
- 父节点和子节点跨组织拒绝。
- 闭包表与 parent 关系一致。
- 并发移动不会形成循环或丢失后代。
- 有 active 子节点、成员、目录 root 或 Skill grant 引用的节点归档返回 `409`。
- 节点 manager 只能维护 member，不能授予 manager 或修改树结构。

### 21.3 目录复选

- 无策略用户默认查看全组织。
- 单个 root，包含和不包含后代。
- 多个 root 并集。
- 重叠 root 去重。
- `limited` 空 roots 不回退为全组织。
- 个人策略覆盖组策略。
- 多个组策略合并。
- 挂在祖先节点上的目录策略对该节点的全部后代成员生效。
- 隐藏人员不出现在树、搜索、详情、计数、分页和自动补全。
- 用户属于多个节点时只返回一次。
- 节点移动和成员变化后下一请求立即更新。

### 21.4 Skill 复选

- `home`、`organization` 和 `restricted`。
- 多组织节点、多权限组和多指定人员并集。
- 父组织节点覆盖后代，子节点不覆盖父级和兄弟节点。
- 权限组只按直接成员。
- `restricted` 空 subjects 无人可用。
- inactive、未知和跨组织用户拒绝。
- invited、隐藏主体和只看见节点但看不全其有效成员的授权请求拒绝。
- use 权不能编辑、发布或重新授权。
- 无权的更窄同名 Skill 不遮蔽有权的更宽 Skill。
- home/organization 残留 grant 和 restricted `write` grant fail closed 并告警。
- 通用 grant/revoke/share 不能绕过 SkillAccessRepository。
- Scope Resources、Admin Skill 列表/详情和 share/move/promote 前置查询不能绕过统一解析器或泄漏存在性。

### 21.5 多人执行

- DM、Web 个人上下文。
- 项目、私有/公开频道、群组、直接收件人和其他用户 DM。
- Cron、Trigger 和后台恢复。
- 任一 audience 成员无权时不进入列表、Prompt 或 Sandbox。
- audience 为空或无法完整解析时 fail closed。
- Prompt 和 Sandbox 使用同一授权 snapshot。
- 执行前 revision 变化时重新校验。
- owner-auth、reach、scratch、global/team scope、fallback mount、非本地执行和长驻进程不能绕过 preflight。
- 绝对路径、符号链接、shell 间接调用和已物化文件不能绕过撤权。
- revision 变化后旧 turn、进程和无法完整清理的 Sandbox 被终止或销毁。
- revision 变化后不自动重放 turn；启用自动重试时验证持久化幂等和外部副作用去重。

### 21.6 撤权和多实例

- 用户停用、移组、组归档、节点移动和撤销 Skill grant。
- 另一个 Core 实例的下一请求立即失权。
- 复用 Sandbox 删除失权 Skill。
- Postgres notification 丢失时 revision 仍保证正确。
- 数据库或 revision 不可用时拒绝而不是回退。
- Pack、deployment layer、plugin/seed、move/promote 与自动同步不会产生缺失 policy、旧 owner key 或孤儿 grant。
- Skill 事务写入递增 `durable_map_versions`，其他实例不会读取旧 JSON 缓存。
- `recordUse`/`lastUsedAt` 等执行期元数据写入不递增授权 revision、不使 snapshot 失效、不参与 content hash。
- 批量导入和 Pack 同步整个事务只递增一次 revision。

### 21.7 API 与 UI

- actor 伪造、隐藏对象 ID 和跨组织 ID。
- GET/PUT revision 与 `409` 冲突。
- 全量替换不会丢失并发修改。
- Admin、Skill manager、组织节点 manager 和普通用户矩阵。
- CSRF、Origin、Content-Type 和限流。
- 全组织、无结果、目录未配置、无查看权限的不同状态文案。

## 22. 验收标准

以下条件全部满足后，才能宣布功能符合严格权限要求：

- [ ] 未知、suspended 和 deprovisioned 用户被拒绝；invited 用户只能访问激活流程，不能读取业务目录或执行 Skill。
- [ ] 邀请用户经 OIDC 首登按组织内唯一 verified email 一次性绑定 issuer+subject 激活；email 未验证、重复或匹配失败时拒绝。
- [ ] 主体非 active 时其全部管理角色（组织管理员、节点 manager、权限组 manager、Skill manager）立即失效。
- [ ] 组织首次启动在同一事务创建根节点和 `organization_authz_state` 行。
- [ ] 默认 active 用户可以查看整个组织。
- [ ] 用户可以复选多个可见组织范围，结果是这些范围的并集。
- [ ] `include_descendants` 的 true/false 语义正确，重叠 root 被去重且不泄漏隐藏节点。
- [ ] `limited` 空范围不会恢复为全组织。
- [ ] 权限组或组织节点存在有效引用时不能归档，必须先显式处理引用。
- [ ] 隐藏用户不出现在搜索、计数、分页、详情和自动补全中。
- [ ] Skill 支持所属范围、全组织和受限范围三种显式模式。
- [ ] Skill 受限模式可复选多个组织节点、权限组和指定人员。
- [ ] Skill 多选主体对单个用户采用并集。
- [ ] `home` 和 `organization` 不允许残留 subjects；`restricted` 空 subjects 明确表示无人可用。
- [ ] 权限组授权只计算直接成员，组织节点授权按祖先/后代规则计算。
- [ ] invited、inactive、隐藏或跨组织主体不能作为 Skill 授权目标。
- [ ] 非组织管理员只能选择其能查看全部有效成员的组织节点或权限组。
- [ ] 多人 audience 对 Skill 采用全员交集校验。
- [ ] DM、项目、私有/公开频道、群组、直接收件人、Web、Cron 和 Trigger 都使用本文定义的权威 audience；无法完整解析或包含外部收件人时所有内部 Skill fail closed。
- [ ] 父组织节点授权覆盖后代，子节点授权不扩散到父级或兄弟节点。
- [ ] 目录可见权不自动授予 Skill 使用权。
- [ ] Skill 使用权不自动授予编辑或转授权权限。
- [ ] 节点/权限组 manager 不能授予 manager 角色，也不能转授 Skill 权限。
- [ ] 手工提交隐藏主体、其他组织主体或伪造 actor 被服务端拒绝。
- [ ] 通用 grant/revoke/share 不能绕过 SkillAccessRepository 修改 `skill:*`。
- [ ] Scope Resources、Admin Skill 视图和 share/move/promote 前置查询通过显式使用权或管理权解析，无权对象统一为 `404`。
- [ ] Skill `write` grant 不参与 use，历史记录完成报告、删除或显式转换。
- [ ] Skill 列表、详情、Prompt、Sandbox、materializer、工具 preflight、Cron、Trigger 和后台执行使用同一个授权 snapshot。
- [ ] Skill create/update/publish/archive/restore/delete/move/promote、Pack、deployment layer、plugin/seed 和自动同步写入原子维护 policy、grants、revision 和审计。
- [ ] Skill domain transition 不被 Repository 绕过，Skill 写入同步递增 DurableMap cache version。
- [ ] cutover 后缺少 Skill `orgId` 或 access policy 时 fail closed，不回退为 `home`。
- [ ] 撤权后另一个 Core 实例的下一请求和下一轮 Agent 执行立即失权。
- [ ] revision 变化会中止旧 turn 和后台进程且不会自动重放；复用 Sandbox 会完整清理或销毁，不可从 scratch、global/team/fallback mount、绝对路径或旧进程读取失权 Skill。
- [ ] 数据库或授权 revision 不可用时 fail closed。
- [ ] 权限修改、组织变更和关键拒绝都有持久化审计。
- [ ] 并发更新不会丢失修改或产生部分写入。
- [ ] Skill 执行期元数据（`lastUsedAt`）写入不递增授权 revision、不使 snapshot 失效。

## 23. 开发交付要求

本功能涉及身份、组织、ACL、目录、Web/Admin UI、Prompt 和 Sandbox，属于高风险跨模块变更。实施时必须：

- 每个阶段只由一个实施者负责同一文件或模块，避免并行修改冲突。
- 先完成 Store 和 Resolver，再接页面；不得以 UI 过滤作为阶段性安全实现。
- 搜索整个 `src/`、`plugins/`、`test/` 和 `scripts/`，替换所有直接绕过统一 Resolver 的生产调用。
- 运行受影响测试、typecheck 和 lint。
- 使用生产形态本地开发实例验证 Portal、Web、Admin、项目目录和真实 Agent 执行。
- 前端变更在 PR 中提供截图。
- 合并前由未参与实现的独立审查者进行 fresh-context 安全审查。

## 24. 开放问题

以下问题不阻塞首期主体设计，但实施前需要产品确认：

1. 同一用户是否允许直接属于多个主要部门，还是一个主部门加多个附属团队。
2. `domain_auto_join` 是否在生产启用，还是生产只允许 invite-only。
3. `organization` Skill 是否只允许组织管理员设置，本文默认是。
4. 目录可见策略是否需要分字段控制，例如能看姓名但不能看邮箱。本文首期按整条最小用户资料控制。
5. 以后是否需要 deny。首期明确不支持。
