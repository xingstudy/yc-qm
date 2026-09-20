# 本地 Docker 沙箱生命周期

本地沙箱的计算容器、网络和出站守卫是可重建资源，`qm-home-*` 卷是用户持久数据。生命周期控制器把发现结果、目标代际、状态和活动租约写入 Postgres，使蓝绿 core 实例对同一个沙箱得到一致结论。

## 自动流程

每次 core 启动和周期巡检都会按 Docker 标签发现本组织的沙箱。旧版本创建、数据库中没有记录的容器先进入观察期；控制器会结合持久租约、后台进程登记和本机引用计数判断是否仍有工作。

新任务需要不同的沙箱镜像或网络代际时，控制器执行以下流程：

1. 将沙箱标记为 `draining`，停止向旧代际分配新租约。
2. 等待已有任务租约和后台进程退出。
3. 通过 PostgreSQL advisory lock 保证多个 core 只有一个实例执行迁移。
4. 删除旧计算容器、网络和守卫，保留 `qm-home-*` 卷。
5. 按新代际创建资源，挂载原卷并签发新租约。

任务结束且没有后台进程时，沙箱会立即停止为 `parked`。开发环境默认闲置两小时、生产环境默认闲置三天后删除计算容器、网络和守卫；工作目录卷仍然保留。后台进程被登记为已回收后会触发一次即时巡检，周期巡检负责处理 core 异常退出后遗留的孤儿容器。

## 配置

```dotenv
LOCAL_SANDBOX_LIFECYCLE_MODE=enforce
LOCAL_SANDBOX_LEASE_TTL_MS=900000
LOCAL_SANDBOX_MIGRATION_WAIT_MS=300000
LOCAL_SANDBOX_LEGACY_OBSERVE_MS=60000
DEEP_IDLE_MACHINE_MS=259200000
DEV_IDLE_MACHINE_MS=7200000
```

- `observe` 只登记和显示状态，不停止或替换旧资源。
- `enforce` 自动休眠、迁移和回收资源。
- 活动租约由持有它的 core 按租约时长的三分之一续期；core 消失后租约自动过期。
- `LOCAL_SANDBOX_LEGACY_OBSERVE_MS` 是无数据库记录旧容器的最短观察窗口。
- `DEEP_IDLE_MACHINE_MS` 控制生产计算资源保留时间，`DEV_IDLE_MACHINE_MS` 控制开发环境；设置为 `0` 可停用深度回收。

开发 Compose 默认使用 `enforce`。生产首次上线默认使用 `observe`，确认旧容器登记、Postgres 表和错误日志正常后，将 `.env.production` 改为 `LOCAL_SANDBOX_LIFECYCLE_MODE=enforce` 并按正常发布流程更新 core。后续镜像或网络升级无需手工执行 `docker stop`。

## 数据边界

自动迁移和深度回收不会删除 `qm-home-*` 卷。只有明确的用户数据销毁流程会删除该卷。不要使用 `docker compose down -v`、通配符卷删除或把工作目录数据仅存放在容器可写层。
