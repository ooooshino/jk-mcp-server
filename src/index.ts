import 'dotenv/config'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

export type BuildStatus = 'RUNNING' | 'SUCCESS' | 'FAILURE' | 'ABORTED' | 'UNSTABLE' | 'NOT_BUILT' | 'UNKNOWN'
export type VerificationConclusion = '通过' | '失败' | '运行中' | '无法判断'

export interface JenkinsClientOptions {
  baseUrl?: string
  username?: string
  token?: string
  log?: {
    defaultTailLines?: number
    maxChars?: number
  }
}

export interface JenkinsBuildRef {
  number: number
  url?: string
}

export interface JenkinsJobInfo {
  name: string
  path: string
  url: string
  buildable: boolean
  lastBuild: JenkinsBuildRef | null
  lastSuccessfulBuild: JenkinsBuildRef | null
  lastFailedBuild: JenkinsBuildRef | null
}

export interface JenkinsBuildInfo {
  jobPath: string
  number: number
  url: string
  status: BuildStatus
  building: boolean
  startedAt: string | null
  durationMs: number
  durationText: string
  triggeredBy: string | null
  parameters: Record<string, string>
  branch: string | null
  commit: string | null
}

export interface JenkinsLogResult {
  text: string
  truncated: boolean
  matches: string[]
  contexts: string[]
}

export interface JenkinsArtifactInfo {
  name: string
  path: string
  size: number | null
  url: string
  type: string
}

export interface JenkinsHealth {
  ok: boolean
  baseUrl: string
  user: string | null
  version: string | null
  permissions: string[]
  error: string | null
}

export interface VerificationReport {
  conclusion: VerificationConclusion
  summary: string
  shouldBlock: boolean
  job: {
    path: string
    url?: string
  }
  build: JenkinsBuildInfo | null
  keyParams: Record<string, string>
  failureSummary: string | null
  logHighlights: Array<{ text: string }>
  artifacts: JenkinsArtifactInfo[]
  nextStep: string
}

type JsonObject = Record<string, unknown>

interface JenkinsClient {
  healthCheck(): Promise<JenkinsHealth>
  listJobs(): Promise<JenkinsJobInfo[]>
  searchJobs(keyword: string): Promise<JenkinsJobInfo[]>
  getJob(jobPath: string): Promise<JenkinsJobInfo>
  getBuild(jobPath: string, buildNumber: number): Promise<JenkinsBuildInfo>
  listBuilds(jobPath: string, limit?: number): Promise<JenkinsBuildInfo[]>
  findBuildByParams(jobPath: string, params: Record<string, string>): Promise<JenkinsBuildInfo | null>
  getBuildLog(jobPath: string, buildNumber: number, maxChars?: number): Promise<JenkinsLogResult>
  getBuildLogTail(jobPath: string, buildNumber: number, lines?: number): Promise<JenkinsLogResult>
  searchBuildLog(jobPath: string, buildNumber: number, keyword: string, contextLines?: number): Promise<JenkinsLogResult>
  listArtifacts(jobPath: string, buildNumber: number): Promise<JenkinsArtifactInfo[]>
  getArtifactInfo(jobPath: string, buildNumber: number, artifactPath: string): Promise<JenkinsArtifactInfo | null>
  listQueue(): Promise<JsonObject[]>
  getQueueItem(queueId: number): Promise<JsonObject | null>
}

export function toJenkinsJobPath(jobPath: string): string {
  const parts = jobPath
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean)
    .map(encodeURIComponent)

  if (parts.length === 0) throw new Error('Job 路径不能为空')

  return `/job/${parts.join('/job/')}`
}

function cleanBaseUrl(baseUrl?: string): string {
  const resolved = baseUrl || process.env.JENKINS_BASE_URL
  if (!resolved) throw new Error('缺少 JENKINS_BASE_URL')
  return resolved.replace(/\/+$/, '')
}

function buildHeaders(options: JenkinsClientOptions): HeadersInit {
  const username = options.username || process.env.JENKINS_USER
  const token = options.token || process.env.JENKINS_API_TOKEN
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'jk-mcp-server/0.1'
  }

  if (username && token) {
    headers.Authorization = `Basic ${Buffer.from(`${username}:${token}`, 'utf8').toString('base64')}`
  }

  return headers
}

async function readError(response: Response): Promise<string> {
  const text = await response.text()
  return text.slice(0, 500)
}

function apiUrl(baseUrl: string, path: string): string {
  return `${baseUrl}${path}`
}

async function fetchJson(baseUrl: string, path: string, headers: HeadersInit): Promise<JsonObject> {
  const response = await fetch(apiUrl(baseUrl, path), { headers })

  if (!response.ok) {
    throw new Error(`Jenkins 请求失败: HTTP ${response.status} ${await readError(response)}`)
  }

  return (await response.json()) as JsonObject
}

async function fetchText(baseUrl: string, path: string, headers: HeadersInit): Promise<string> {
  const response = await fetch(apiUrl(baseUrl, path), { headers: { ...headers, Accept: 'text/plain' } })

  if (!response.ok) {
    throw new Error(`Jenkins 日志请求失败: HTTP ${response.status} ${await readError(response)}`)
  }

  return response.text()
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function buildRef(value: unknown): JenkinsBuildRef | null {
  const object = asObject(value)
  const number = object?.number
  if (!object || typeof number !== 'number') return null
  return {
    number,
    url: typeof object.url === 'string' ? object.url : undefined
  }
}

function normalizeJob(raw: JsonObject, fallbackPath?: string): JenkinsJobInfo {
  const path = typeof raw.fullName === 'string' ? raw.fullName : fallbackPath || String(raw.name || '')
  return {
    name: String(raw.name || path.split('/').at(-1) || ''),
    path,
    url: String(raw.url || ''),
    buildable: Boolean(raw.buildable ?? true),
    lastBuild: buildRef(raw.lastBuild),
    lastSuccessfulBuild: buildRef(raw.lastSuccessfulBuild),
    lastFailedBuild: buildRef(raw.lastFailedBuild)
  }
}

function mapStatus(result: unknown, building: unknown): BuildStatus {
  if (building === true) return 'RUNNING'
  if (typeof result !== 'string') return 'UNKNOWN'
  if (['SUCCESS', 'FAILURE', 'ABORTED', 'UNSTABLE', 'NOT_BUILT'].includes(result)) return result as BuildStatus
  return 'UNKNOWN'
}

function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0 秒'
  const seconds = Math.round(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  if (minutes <= 0) return `${remaining} 秒`
  return `${minutes} 分 ${remaining} 秒`
}

function formatStartedAt(timestamp: unknown): string | null {
  if (typeof timestamp !== 'number' || timestamp <= 0) return null
  return new Date(timestamp).toISOString()
}

function extractParameters(actions: unknown): Record<string, string> {
  const params: Record<string, string> = {}
  for (const action of asArray(actions)) {
    const actionObject = asObject(action)
    for (const parameter of asArray(actionObject?.parameters)) {
      const parameterObject = asObject(parameter)
      if (typeof parameterObject?.name !== 'string') continue
      const value = parameterObject.value
      params[parameterObject.name] = value === undefined || value === null ? '' : String(value)
    }
  }
  return params
}

function extractTriggeredBy(actions: unknown): string | null {
  for (const action of asArray(actions)) {
    const actionObject = asObject(action)
    for (const cause of asArray(actionObject?.causes)) {
      const causeObject = asObject(cause)
      if (typeof causeObject?.userName === 'string') return causeObject.userName
      if (typeof causeObject?.userId === 'string') return causeObject.userId
      if (typeof causeObject?.shortDescription === 'string') return causeObject.shortDescription
    }
  }
  return null
}

function firstParam(params: Record<string, string>, names: string[]): string | null {
  const entries = Object.entries(params)
  for (const name of names) {
    const found = entries.find(([key]) => key.toLowerCase() === name.toLowerCase())
    if (found && found[1]) return found[1]
  }
  return null
}

function normalizeBuild(raw: JsonObject, jobPath: string): JenkinsBuildInfo {
  const parameters = extractParameters(raw.actions)
  const duration = typeof raw.duration === 'number' ? raw.duration : 0
  return {
    jobPath,
    number: Number(raw.number),
    url: String(raw.url || ''),
    status: mapStatus(raw.result, raw.building),
    building: raw.building === true,
    startedAt: formatStartedAt(raw.timestamp),
    durationMs: duration,
    durationText: durationText(duration),
    triggeredBy: extractTriggeredBy(raw.actions),
    parameters,
    branch: firstParam(parameters, ['BRANCH', 'GIT_BRANCH', 'branch', 'gitBranch', 'SOURCE_BRANCH']),
    commit: firstParam(parameters, ['GIT_COMMIT', 'COMMIT', 'commit', 'SHA', 'GIT_SHA'])
  }
}

export function redactSecrets(text: string): string {
  return text
    .replace(/(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+/gi, '$1[REDACTED]')
    .replace(/(cookie\s*:\s*)[^\n\r]+/gi, '$1[REDACTED]')
    .replace(/\b(token|password|secret|api[_-]?key|session)\b\s*[:=]\s*["']?[^"'\s\n\r]+["']?/gi, '$1=[REDACTED]')
}

function limitText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: text.slice(-maxChars), truncated: true }
}

function tailLines(text: string, lines: number): { text: string; truncated: boolean } {
  const split = text.split(/\r?\n/)
  if (split.length <= lines) return { text, truncated: false }
  return { text: split.slice(-lines).join('\n'), truncated: true }
}

function searchContexts(text: string, keyword: string, contextLines: number): JenkinsLogResult {
  const lines = text.split(/\r?\n/)
  const matches: string[] = []
  const contexts: string[] = []
  const lowered = keyword.toLowerCase()

  lines.forEach((line, index) => {
    if (!line.toLowerCase().includes(lowered)) return
    matches.push(line)
    const start = Math.max(0, index - contextLines)
    const end = Math.min(lines.length, index + contextLines + 1)
    contexts.push(lines.slice(start, end).join('\n'))
  })

  return {
    text: contexts.join('\n---\n') || '',
    truncated: false,
    matches,
    contexts
  }
}

function artifactType(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.includes('report')) return 'html-report'
  if (lower.endsWith('.zip') || lower.endsWith('.apk') || lower.endsWith('.ipa') || lower.endsWith('.tar.gz')) return 'package'
  if (lower.endsWith('.map')) return 'source-map'
  if (lower.endsWith('.xml') || lower.includes('junit')) return 'test-report'
  return 'artifact'
}

function matchBuildParams(build: JenkinsBuildInfo, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => {
    if (value === undefined || value === '') return true
    if (key.toLowerCase() === 'branch') return build.branch === value
    if (key.toLowerCase() === 'commit') return build.commit === value
    const found = Object.entries(build.parameters).find(([paramKey]) => paramKey.toLowerCase() === key.toLowerCase())
    return found?.[1] === value
  })
}

export function createJenkinsClient(options: JenkinsClientOptions = {}): JenkinsClient {
  const headers = buildHeaders(options)
  const defaultTailLines = options.log?.defaultTailLines || 300
  const maxChars = options.log?.maxChars || 50000
  const getBaseUrl = () => cleanBaseUrl(options.baseUrl)

  async function getJob(jobPath: string): Promise<JenkinsJobInfo> {
    const baseUrl = getBaseUrl()
    const raw = await fetchJson(baseUrl, `${toJenkinsJobPath(jobPath)}/api/json`, headers)
    return normalizeJob(raw, jobPath)
  }

  async function getBuild(jobPath: string, buildNumber: number): Promise<JenkinsBuildInfo> {
    const baseUrl = getBaseUrl()
    const raw = await fetchJson(baseUrl, `${toJenkinsJobPath(jobPath)}/${buildNumber}/api/json`, headers)
    return normalizeBuild(raw, jobPath)
  }

  return {
    async healthCheck() {
      const baseUrl = options.baseUrl || process.env.JENKINS_BASE_URL || ''
      try {
        if (!baseUrl) throw new Error('缺少 JENKINS_BASE_URL')
        const rootResponse = await fetch(apiUrl(baseUrl, '/api/json'), { headers })
        if (!rootResponse.ok) {
          return {
            ok: false,
            baseUrl,
            user: null,
            version: null,
            permissions: [],
            error: `Jenkins 地址或认证不可用: HTTP ${rootResponse.status}`
          }
        }

        const version = rootResponse.headers.get('x-jenkins')
        let user: string | null = null
        let permissions: string[] = []

        try {
          const who = await fetchJson(baseUrl, '/whoAmI/api/json', headers)
          user = typeof who.name === 'string' ? who.name : null
          permissions = asArray(who.authorities).filter((item): item is string => typeof item === 'string')
        } catch {
          permissions = []
        }

        return { ok: true, baseUrl, user, version, permissions, error: null }
      } catch (error) {
        return {
          ok: false,
          baseUrl,
          user: null,
          version: null,
          permissions: [],
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    async listJobs() {
      const baseUrl = getBaseUrl()
      const root = await fetchJson(baseUrl, '/api/json', headers)
      return asArray(root.jobs).map((job) => normalizeJob(asObject(job) || {}))
    },

    async searchJobs(keyword: string) {
      const jobs = await this.listJobs()
      const lowered = keyword.toLowerCase()
      return jobs.filter((job) => job.name.toLowerCase().includes(lowered) || job.path.toLowerCase().includes(lowered))
    },

    getJob,

    getBuild,

    async listBuilds(jobPath: string, limit = 10) {
      const baseUrl = getBaseUrl()
      const job = await fetchJson(baseUrl, `${toJenkinsJobPath(jobPath)}/api/json`, headers)
      const refs = asArray(job.builds)
        .map((item) => asObject(item)?.number)
        .filter((number): number is number => typeof number === 'number')
        .slice(0, limit)

      return Promise.all(refs.map((number) => getBuild(jobPath, number)))
    },

    async findBuildByParams(jobPath: string, params: Record<string, string>) {
      const builds = await this.listBuilds(jobPath, 30)
      return builds.find((build) => matchBuildParams(build, params)) || null
    },

    async getBuildLog(jobPath: string, buildNumber: number, requestedMaxChars = maxChars) {
      const baseUrl = getBaseUrl()
      const raw = await fetchText(baseUrl, `${toJenkinsJobPath(jobPath)}/${buildNumber}/consoleText`, headers)
      const redacted = redactSecrets(raw)
      const limited = limitText(redacted, requestedMaxChars)
      return { ...limited, matches: [], contexts: [] }
    },

    async getBuildLogTail(jobPath: string, buildNumber: number, lines = defaultTailLines) {
      const baseUrl = getBaseUrl()
      const raw = await fetchText(baseUrl, `${toJenkinsJobPath(jobPath)}/${buildNumber}/consoleText`, headers)
      const redacted = redactSecrets(raw)
      const tailed = tailLines(redacted, lines)
      return { ...tailed, matches: [], contexts: [] }
    },

    async searchBuildLog(jobPath: string, buildNumber: number, keyword: string, contextLines = 5) {
      const log = await this.getBuildLog(jobPath, buildNumber)
      const result = searchContexts(log.text, keyword, contextLines)
      return {
        ...result,
        text: redactSecrets(result.text),
        matches: result.matches.map(redactSecrets),
        contexts: result.contexts.map(redactSecrets),
        truncated: log.truncated
      }
    },

    async listArtifacts(jobPath: string, buildNumber: number) {
      const baseUrl = getBaseUrl()
      const raw = await fetchJson(baseUrl, `${toJenkinsJobPath(jobPath)}/${buildNumber}/api/json`, headers)
      const buildUrl = `${baseUrl}${toJenkinsJobPath(jobPath)}/${buildNumber}/`
      return asArray(raw.artifacts).map((artifact) => {
        const object = asObject(artifact) || {}
        const path = String(object.relativePath || object.path || object.fileName || '')
        const name = String(object.fileName || path.split('/').at(-1) || path)
        return {
          name,
          path,
          size: typeof object.size === 'number' ? object.size : null,
          url: `${buildUrl.replace(/\/+$/, '')}/artifact/${path}`,
          type: artifactType(path)
        }
      })
    },

    async getArtifactInfo(jobPath: string, buildNumber: number, artifactPath: string) {
      const artifacts = await this.listArtifacts(jobPath, buildNumber)
      return artifacts.find((artifact) => artifact.path === artifactPath || artifact.name === artifactPath) || null
    },

    async listQueue() {
      const baseUrl = getBaseUrl()
      const raw = await fetchJson(baseUrl, '/queue/api/json', headers)
      return asArray(raw.items).filter((item): item is JsonObject => Boolean(asObject(item)))
    },

    async getQueueItem(queueId: number) {
      const items = await this.listQueue()
      return items.find((item) => item.id === queueId) || null
    }
  }
}

export async function createVerificationReport(
  client: JenkinsClient,
  input: {
    jobPath: string
    buildNumber?: number
    branch?: string
    env?: string
    channel?: string
    commit?: string
    logKeyword?: string
  }
): Promise<VerificationReport> {
  const job = await client.getJob(input.jobPath)
  const params = Object.fromEntries(
    Object.entries({
      branch: input.branch,
      env: input.env,
      channel: input.channel,
      commit: input.commit
    }).filter(([, value]) => value)
  ) as Record<string, string>

  const build =
    typeof input.buildNumber === 'number'
      ? await client.getBuild(input.jobPath, input.buildNumber)
      : await client.findBuildByParams(input.jobPath, params)

  if (!build) {
    return {
      conclusion: '无法判断',
      summary: '没有找到匹配的 Jenkins 构建。',
      shouldBlock: true,
      job: { path: job.path, url: job.url },
      build: null,
      keyParams: params,
      failureSummary: '没有匹配构建',
      logHighlights: [],
      artifacts: [],
      nextStep: '确认 Job、分支、环境、渠道或 commit 参数是否正确。'
    }
  }

  const artifacts = await client.listArtifacts(input.jobPath, build.number)
  const logKeyword = input.logKeyword || 'ERROR'
  const log = build.status === 'FAILURE' || build.status === 'UNSTABLE'
    ? await client.searchBuildLog(input.jobPath, build.number, logKeyword, 3)
    : { contexts: [], text: '', matches: [], truncated: false }

  if (build.status === 'SUCCESS') {
    return {
      conclusion: '通过',
      summary: 'Jenkins 构建成功，产物已生成。',
      shouldBlock: false,
      job: { path: job.path, url: job.url },
      build,
      keyParams: build.parameters,
      failureSummary: null,
      logHighlights: [],
      artifacts,
      nextStep: '可以把该结果写回 Loop 看板，作为验证通过证据。'
    }
  }

  if (build.status === 'RUNNING') {
    return {
      conclusion: '运行中',
      summary: 'Jenkins 构建仍在运行。',
      shouldBlock: false,
      job: { path: job.path, url: job.url },
      build,
      keyParams: build.parameters,
      failureSummary: null,
      logHighlights: [],
      artifacts,
      nextStep: '等待构建结束后重新读取结果。'
    }
  }

  return {
    conclusion: '失败',
    summary: `Jenkins 构建失败，状态为 ${build.status}。`,
    shouldBlock: true,
    job: { path: job.path, url: job.url },
    build,
    keyParams: build.parameters,
    failureSummary: log.matches[0] || '构建失败，但没有找到明确错误行。',
    logHighlights: (log.contexts.length ? log.contexts : [log.text]).filter(Boolean).map((text) => ({ text })),
    artifacts,
    nextStep: '查看失败日志片段，判断是代码、环境、依赖还是 Job 配置问题；修复前不要标记完成。'
  }
}

function textContent(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
      }
    ]
  }
}

export function createServer() {
  const server = new McpServer({
    name: 'jk-mcp-server',
    version: '0.1.0'
  })

  const client = createJenkinsClient()

  server.tool('jenkins.healthCheck', '检查 Jenkins 连接、认证和当前用户权限', {}, async () => textContent(await client.healthCheck()))

  server.tool('jenkins.listJobs', '列出当前账号可访问的 Jenkins Job', {}, async () => textContent(await client.listJobs()))

  server.tool(
    'jenkins.searchJobs',
    '按关键字搜索 Jenkins Job',
    { keyword: z.string().describe('Job 名称或路径关键字') },
    async ({ keyword }) => textContent(await client.searchJobs(keyword))
  )

  server.tool(
    'jenkins.getJob',
    '读取 Jenkins Job 基础信息',
    { jobPath: z.string().describe('Job 路径，例如 project/test-build') },
    async ({ jobPath }) => textContent(await client.getJob(jobPath))
  )

  server.tool(
    'jenkins.getBuild',
    '读取指定 Jenkins 构建',
    { jobPath: z.string(), buildNumber: z.number().int().positive() },
    async ({ jobPath, buildNumber }) => textContent(await client.getBuild(jobPath, buildNumber))
  )

  server.tool(
    'jenkins.listBuilds',
    '读取最近 N 次 Jenkins 构建',
    { jobPath: z.string(), limit: z.number().int().positive().max(50).optional() },
    async ({ jobPath, limit }) => textContent(await client.listBuilds(jobPath, limit))
  )

  server.tool(
    'jenkins.findBuildByParams',
    '按分支、环境、渠道或 commit 查找 Jenkins 构建',
    {
      jobPath: z.string(),
      branch: z.string().optional(),
      env: z.string().optional(),
      channel: z.string().optional(),
      commit: z.string().optional()
    },
    async ({ jobPath, ...params }) =>
      textContent(await client.findBuildByParams(jobPath, Object.fromEntries(Object.entries(params).filter(([, value]) => value)) as Record<string, string>))
  )

  server.tool(
    'jenkins.getBuildLog',
    '读取 Jenkins 构建日志，默认限制大小并脱敏',
    { jobPath: z.string(), buildNumber: z.number().int().positive(), maxChars: z.number().int().positive().optional() },
    async ({ jobPath, buildNumber, maxChars }) => textContent(await client.getBuildLog(jobPath, buildNumber, maxChars))
  )

  server.tool(
    'jenkins.getBuildLogTail',
    '读取 Jenkins 构建日志尾部，默认脱敏',
    { jobPath: z.string(), buildNumber: z.number().int().positive(), lines: z.number().int().positive().optional() },
    async ({ jobPath, buildNumber, lines }) => textContent(await client.getBuildLogTail(jobPath, buildNumber, lines))
  )

  server.tool(
    'jenkins.searchBuildLog',
    '按关键字搜索 Jenkins 构建日志并返回上下文',
    { jobPath: z.string(), buildNumber: z.number().int().positive(), keyword: z.string(), contextLines: z.number().int().min(0).optional() },
    async ({ jobPath, buildNumber, keyword, contextLines }) => textContent(await client.searchBuildLog(jobPath, buildNumber, keyword, contextLines))
  )

  server.tool(
    'jenkins.listArtifacts',
    '列出 Jenkins 构建产物地址',
    { jobPath: z.string(), buildNumber: z.number().int().positive() },
    async ({ jobPath, buildNumber }) => textContent(await client.listArtifacts(jobPath, buildNumber))
  )

  server.tool(
    'jenkins.getArtifactInfo',
    '读取指定 Jenkins 构建产物信息',
    { jobPath: z.string(), buildNumber: z.number().int().positive(), artifactPath: z.string() },
    async ({ jobPath, buildNumber, artifactPath }) => textContent(await client.getArtifactInfo(jobPath, buildNumber, artifactPath))
  )

  server.tool('jenkins.listQueue', '读取 Jenkins 当前队列', {}, async () => textContent(await client.listQueue()))

  server.tool(
    'jenkins.getQueueItem',
    '读取 Jenkins 队列项',
    { queueId: z.number().int().positive() },
    async ({ queueId }) => textContent(await client.getQueueItem(queueId))
  )

  server.tool(
    'jenkins.createVerificationReport',
    '生成适合写回 Loop 看板的 Jenkins 验证结果',
    {
      jobPath: z.string(),
      buildNumber: z.number().int().positive().optional(),
      branch: z.string().optional(),
      env: z.string().optional(),
      channel: z.string().optional(),
      commit: z.string().optional(),
      logKeyword: z.string().optional()
    },
    async (input) => textContent(await createVerificationReport(client, input))
  )

  return server
}

export async function startServer() {
  const transport = new StdioServerTransport()
  await createServer().connect(transport)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
