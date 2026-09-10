# Local Docker 出站策略

“治理 → 数据边界”中的“策略仅为草案”表示沙箱尚未启用强制出站代理。保存允许列表或禁止列表并不会改变 Docker 网络。启用后，域名规则按治理范围解析，并通过每轮签发的代理令牌执行。

## 需要哪些容器

- 一个共享的 `egress-proxy` 服务：内置 Envoy 和鉴权服务，验证令牌、检查域名和目标 IP、向 core 回传审计记录。
- 每个沙箱一个自动管理的网络守卫：使用同一代理镜像，但仅运行防火墙初始化和保活进程。先安装规则，再启动沙箱；沙箱共享它的网络空间，没有修改防火墙和发送原始网络包的权限。

代理不持有工作目录卷。沙箱升级网络配置时保留原有 `qm-home-*` 卷。休眠沙箱保留轻量守卫以便安全恢复；深度闲置回收删除容器和守卫，保留工作目录卷。

## 源码 Compose

先查询 Docker 默认宿主网关：

```bash
docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'
```

在 `.env` 中设置（以下 `172.17.0.1` 必须替换为实际网关地址）。已有 `COMPOSE_PROFILES` 时追加 `egress`，例如将 `COMPOSE_PROFILES=auth` 改为 `COMPOSE_PROFILES=auth,egress`，保留其他已启用的服务：

```dotenv
COMPOSE_PROFILES=egress
LOCAL_SANDBOX_EGRESS_PROXY_URL=http://host.docker.internal:48080
QM_EGRESS_BIND_ADDRESS=172.17.0.1
```

不要填写 `127.0.0.1`：沙箱内的回环地址指向沙箱自身。不要把代理发布到公网。若 Docker 配置了 `host-gateway-ip`，使用该配置对应的宿主 IPv4 地址，而不是默认 bridge 网关。

结束活动任务后，停止需要迁移的旧沙箱，使用页面或错误信息中的具体容器名称：

```bash
docker stop <sandbox-container-name>
docker compose up -d --build egress-proxy core
```

命令显式指定了 `egress-proxy`，Compose 会自动启用该服务，因此这里无需额外传 `--profile egress`。日常执行不指定服务的 `docker compose up -d` 时，`COMPOSE_PROFILES=auth,egress` 会启用这两组可选服务；没有 profile 的服务默认启用。

下一轮会自动创建受保护的沙箱网络，保留工作目录。不要运行 `docker compose down -v` 或删除 `qm-home-*` 卷。正在运行且网络配置不匹配的旧沙箱会拒绝新任务，并提示先完成活动任务、停止容器。

Compose 会自动给 core 设置 `LOCAL_SANDBOX_EGRESS_IMAGE=qm-egress-proxy:latest`。代理的 `CAPABILITY_SECRET`、`CORE_SIGNING_SECRET` 与 core 使用同一组现有值，无需生成或更换密钥；`CORE_API_URL=http://host.docker.internal:8080` 用于成员会话校验和审计回传。core 的 `AGENT_API_URL` 供沙箱通过代理调用控制平面。

## 生产 Compose

在 `.env.production` 设置相同的三个变量，再使用正常的生产发布脚本部署支持该功能的版本。代理镜像已加入生产构建、漏洞扫描、签名验证和 `images.production.env`，变量名为 `QM_EGRESS_PROXY_IMAGE`。部署脚本保留环境文件中已配置的 profiles，检测到代理 URL 后追加启用 `egress` profile。core 和网络守卫使用同一个已验证的代理镜像摘要；不要手写可变标签替代生产镜像清单。

旧版生产镜像不包含此功能，需要先发布当前代码。启用或更改网络配置前同样需要结束任务并停止旧沙箱。已有工作目录卷、数据库和凭据保持不变。

## 直接运行 core / 本地开发实例

除了代理 URL，还要在 core 的启动环境中设置：

```dotenv
LOCAL_SANDBOX_EGRESS_IMAGE=qm-egress-proxy:latest
```

单独启动代理容器时，将其 48080 端口绑定到 Docker 宿主网关，设置与开发 core 相同的两个签名密钥，并将 `CORE_API_URL` 指向实际开发 core 端口。不要让开发代理连接生产 core。支持 Linux Docker；需要 Docker 能为守卫授予 `NET_ADMIN` 并安装 IPv4、IPv6 iptables 规则。

## 生效范围和验证

1. 治理页面应显示域名策略已强制执行；在组织、组织架构组或访问组保存规则。
2. 在新的成员任务中，允许域名的 HTTP/HTTPS 请求应成功，禁止域名应返回代理拒绝。
3. 取消代理环境变量、直接连接外部 IP、外部 DNS、UDP 和 IPv6 都应失败。Node 24 的标准请求也自动启用环境代理；不支持 HTTP 代理的工具会被阻止，需要改用兼容工具。
4. 停止代理后外部请求应失败。缺少、失效或签名不匹配的令牌同样不能获得出站访问；本地文件维护仍可运行。
5. 代理审计记录回传 core 并存储在其 Postgres 中。直接被网络守卫丢弃的连接不会产生域名代理审计记录。

规则使用每轮令牌快照，在后续轮次的新连接上生效。已建立的 CONNECT 隧道、已有后台进程持有的令牌不会即时撤销；需要立即切断时，结束任务并停止相关沙箱。HTTP CONNECT 提供目标域名/IP 边界，不解密 HTTPS 内容，也不按 URL 路径过滤。允许列表为空表示除禁止项外允许出站；配置代理并不等于默认禁止所有域名。

## 允许访问公司内网

在“治理 → 数据边界 → 允许访问内网的域名/IP”中，每行填写一条规则：

```text
kibana.example.com
10.1.37.205
10.1.37.0/24
10.1.37.200-10.1.37.210
fd00::/64
fd00::10-fd00::20
```

支持域名（包含子域名）、单个 IPv4/IPv6 地址、CIDR 网段和包含两端的 IP 范围。起止地址必须属于同一 IP 版本，起始地址不得大于结束地址。域名规则允许该域名解析到私网；IP 规则同时匹配直接连接目标和域名解析结果，所有 DNS 返回的私网地址都必须获准。

这些规则在 Auto 安全模式下豁免指定目标的私网限制，仍须通过普通域名允许名单和禁止名单。若普通允许名单非空，也要加入要访问的域名；禁止规则优先，回环、链路本地和云元数据目标仍然禁止。空的内网列表表示没有额外私网例外，不表示放开全部内网。

组织、祖先部门、访问组和当前范围的例外合并；多人会话只保留所有参与者共同拥有的规则。规则写入 Postgres，在后续轮次的新连接上生效。删除例外不会立即撤销已经建立的代理隧道或旧令牌。API 使用 `privateNetworkAllowedHosts` 数组；只包含原有域名名单的旧配置保持兼容。

代理宿主机本身需要能够访问内网，例如通过公司 VPN。添加规则解决策略拒绝，不能建立缺失的 VPN 路由。代理返回 `403` 且日志显示 `detail=lua_response upstream=-` 时，应先检查策略和令牌；目标服务返回 `401` 则说明已到达服务，但仍需完成服务认证。

## 故障定位

- 仍显示草案：检查 core 是否收到了 `LOCAL_SANDBOX_EGRESS_PROXY_URL`，并重新创建 core。
- 显示控制平面未激活：配置 core 的 `CORE_SIGNING_SECRET` 与 `AGENT_API_URL`；本地网络守卫会保持禁止出站。
- 守卫初始化失败：检查镜像是否包含本版本代码、Docker `NET_ADMIN` 能力和 iptables 支持。程序不会启动无防火墙的替代沙箱。
- 全部域名被拒绝：检查代理与 core 的密钥是否一致、代理能否连接 `CORE_API_URL`、成员是否仍有效、令牌是否过期及范围策略。
- 请求连接超时：检查 `QM_EGRESS_BIND_ADDRESS` 与实际 `host.docker.internal` 地址是否一致、代理服务是否启动及宿主机防火墙。

网络实现使用 Docker 的 [共享容器网络空间](https://docs.docker.com/engine/network/) 和 [Linux capabilities](https://docs.docker.com/engine/containers/run/)；Node 代理配置见 [Node 24 文档](https://nodejs.org/download/release/v24.15.0/docs/api/cli.html#node_use_env_proxy1)。
