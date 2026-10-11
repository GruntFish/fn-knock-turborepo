# Windows 安装恢复与存储诊断

安装器兼容 Windows PowerShell 5.1。注册表键不存在时回滚应正常完成，权限不足时必须停止并保留恢复快照。

每次安装都先停止服务，再备份 `config`、`data`（含 SQLite/WAL）、`gateway`、`waf`、`certificates`、`secrets`；升级另备份旧程序。`rollback/pending/data-manifest.json` 记录原始目录存在状态、文件长度和 SHA-256。复制校验完成后才写 `snapshot.ready`；回滚入口先验证数据与安装元数据快照，再允许卸载或替换程序；恢复数据时再次校验。`mutation.started` 记录安装已允许修改现场，若此时 `snapshot.ready` 丢失，保留事务并停止恢复，不能按未开始安装处理。新事务的 `snapshot.format` 为 `2`，原有 `first`、`repair-first`、`upgrade` 标记不变；旧的首次安装事务没有数据快照，恢复时保留其现场数据。

不要把删除 `rollback/pending` 或执行 `reset-panel-password` 当作诊断步骤。前者可能丢掉唯一恢复快照；后者会修改密码、会话和登录失败状态。

## 离线诊断

服务停止后，以有权读取数据的账户运行：

```powershell
& 'C:\Program Files\Knock 敲门\fn-knock-service.exe' diagnose-storage --json
```

也可检查已有离线数据库副本：

```powershell
& '.\fn-knock-service.exe' diagnose-storage --database 'D:\offline-copy\fn-knock.sqlite3' --json
```

命令不会自动停服，不向原数据库写入，也不会重置密码。它先取得拒绝并发写入/删除的只读文件句柄，将数据库、WAL 和回滚日志复制到受 ACL 保护的临时目录，不复制 SHM；然后仅在临时副本上做完整性检查和真实存储初始化。临时副本执行完即清理。

报告 `schema_version` 为 `1`，包含程序版本、调用者 SID、源文件属性、迁移记录以及初始化阶段和错误码，不包含配置正文、数据库记录、密码或会话。`service_identity_verified` 始终为 `false`：管理员身份下的副本诊断成功，不代表 `NT SERVICE\FnKnock` 能访问原库。记录的迁移元数据来自检查前副本，`integrity_check` 表示完整 SQLite 完整性检查通过，`migration_validation` 为 `true`/`false`/`null`（全部通过/检测到不兼容/未完成），`initialization_passed` 表示全部实际初始化检查通过。迁移记录只读取明确的内部表和已知迁移名称；`migration_inspection_failure` 单独报告读取记录的问题，不跳过真实初始化或掩盖其失败阶段。

退出码：`0` 检查通过；`1` 存储问题；`2` 参数、停服/安全复制前提或临时副本清理失败。服务运行中、源文件被写入进程占用或路径包含重解析点时拒绝检查。报告源文件只读属性，但不会为了模拟原库只读状态把副本也设置为只读。

## 日志和恢复策略

- `ProgramData\FnKnock\state\status.json` 保留旧字段，新增可选的 `startup_stage`、`error_code`、`retryable`，以及 `diagnostic_log`、可选的 `log_error`。错误摘要脱敏且长度受限。
- `ProgramData\FnKnock\logs\service.log` 保存脱敏的启动错误链，当前文件与 `.1` 各最多 512 KiB。退出前同步刷新。
- `ProgramData\FnKnock\logs\installer.log` 保留事务失败和本次启动状态，在回滚之外轮转保留。不要将旧状态文件的错误当作本次启动结果。
- 无效配置、迁移不兼容、损坏库、明确权限失败停止服务等待处理。其他失败按 5/30/60 秒重启，之后 `None` 停止自动恢复；连续 24 小时无故障后 SCM 重置计数。修复后可手工启动服务。

## 发布验收

Windows CI 与 release 必须通过 Rust 验证、PowerShell 5.1 事务回归、运行时与真实 NSIS 冒烟测试。失败时仅上传已知的操作日志/状态文件，不能上传数据库、密钥或回滚目录。

发布前另在中文 Windows 10、Windows 11 管理员环境验收：全新安装、保留旧数据重装、未就绪启动回滚、已就绪标记残留恢复、升级恢复、只读/WAL 访问冲突。确认安装器显示具体错误，日志保留根因且不包含错误文本中的配置值，原有数据未变化，连续故障最多自动重启三次。没有故障机报告时，测试通过只能说明这些机制得到验证，不能据此宣称已确认用户现场的 SQLite 根因。
