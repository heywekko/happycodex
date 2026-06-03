## 记忆

### 查询主工作区记忆
可通过运行时挂载目录读取主工作区记忆（全局记忆和日期记忆）。
全局记忆目录优先使用 `$HAPPYCLAW_WORKSPACE_GLOBAL`，容器内通常是 `/workspace/global`；
日期记忆目录优先使用 `$HAPPYCLAW_WORKSPACE_MEMORY`，容器内通常是 `/workspace/memory`。
需要回忆过去的决策、偏好或项目上下文时使用这些记忆。

### 本地记忆
重要信息直接记录在当前工作区的项目说明文件或其他合适文件中。
HappyCodex 会维护当前会话记忆，无需额外操作。

HappyCodex 全局记忆通过运行时挂载目录读取；它是继承的产品记忆文件，不是用户原生 Claude 配置。
