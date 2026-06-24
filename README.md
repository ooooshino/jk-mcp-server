# Jenkins MCP 服务

这是一个只读的 Jenkins MCP 服务，用于 AI Loop 验证。它可以让 AI Agent 安全读取 Jenkins 信息，并把构建证据整理成适合写回本地 Loop 看板的验证报告。

## 范围

第一版刻意保持只读。

已支持：

- 检查 Jenkins 连接和当前账号权限。
- 查询和搜索 Job。
- 查询构建状态和构建参数。
- 按分支、环境、渠道或提交号匹配构建。
- 读取日志尾部、搜索关键字，并隐藏敏感信息。
- 列出构建产物。
- 查看队列。
- 生成适合 Loop 看板使用的验证报告。

第一版不支持：

- 触发构建。
- 发布生产环境。
- 修改 Jenkins Job 配置。
- 创建、删除、禁用或自动重试 Job。
- 在仓库里保存 Jenkins Token。

## 主要用途

- Maker Agent 可以确认当前分支是否已有可用 Jenkins 构建。
- Checker Agent 可以独立检查 CI 证据，而不是只相信前一步的口头结论。
- Merge Agent 可以在合并后读取验证结果，再决定任务能否完成。
- 最终输出包含结论、构建链接、关键参数、失败日志、产物地址和下一步建议。

## 环境要求

- Node.js 22 或更高版本。
- pnpm。
- 一个具备 Job、构建、日志、产物和队列读取权限的 Jenkins 账号。
- Jenkins API Token 存在本地 `.env` 或 shell 环境变量中。

## 安装

安装依赖：

```sh
pnpm install
```

把 `.env.example` 复制为 `.env`，并填入本机配置。不要提交 `.env`。

```sh
JENKINS_BASE_URL=<your-jenkins-base-url>
JENKINS_USER=<your-jenkins-user>
JENKINS_API_TOKEN=<your-jenkins-api-token>
```

这些值只是占位符。真实 Jenkins 地址、用户名和 Token 只放在本机 `.env` 里。

运行检查：

```sh
pnpm test
pnpm check
```

本地启动 MCP 服务：

```sh
pnpm dev
```

## Codex MCP 配置

本机 Codex 配置示例：

```toml
[mcp_servers.jenkins]
command = "pnpm"
args = ["--dir", "/path/to/jk-mcp-server", "dev"]
startup_timeout_sec = 10
```

账号和 Token 放在本项目的 `.env` 文件或 shell 环境变量里，不要写进 Codex 配置。

## 常见用法

检查 Jenkins 访问：

```text
jenkins.healthCheck
```

读取 Job：

```json
{
  "jobPath": "project/test-build"
}
```

按分支和环境查找构建：

```json
{
  "jobPath": "project/test-build",
  "branch": "feature/demo",
  "env": "test"
}
```

生成 Loop 看板可用的验证报告：

```json
{
  "jobPath": "project/test-build",
  "branch": "feature/demo",
  "env": "test",
  "channel": "standard",
  "logKeyword": "ERROR"
}
```

## 工具列表

- `jenkins.healthCheck`
- `jenkins.listJobs`
- `jenkins.searchJobs`
- `jenkins.getJob`
- `jenkins.getBuild`
- `jenkins.listBuilds`
- `jenkins.findBuildByParams`
- `jenkins.getBuildLog`
- `jenkins.getBuildLogTail`
- `jenkins.searchBuildLog`
- `jenkins.listArtifacts`
- `jenkins.getArtifactInfo`
- `jenkins.listQueue`
- `jenkins.getQueueItem`
- `jenkins.createVerificationReport`

## Job 路径

使用斜杠分隔 Jenkins 文件夹路径：

```text
project/test-build
```

服务内部会把它转换成 Jenkins 文件夹 URL。

## 验证报告

`jenkins.createVerificationReport` 会返回适合写入这些 Loop 字段的数据：

- `verification`
- `selfTest`
- `postMergeVerification`
- `decisionLog`
- `statusHistory`

报告包含验证结论、Job、构建、关键参数、失败摘要、日志片段、产物地址、是否阻塞和下一步建议。

## 安全说明

- 构建日志返回前会隐藏敏感内容。
- 大日志默认会截断。
- 产物工具只返回地址，不会自动下载文件。
- Jenkins 不可访问时会返回明确的阻塞原因，不会伪造通过结果。
- 生产发布自动化不在第一版范围内。
