import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http'
import {
  createJenkinsClient,
  createVerificationReport,
  redactSecrets,
  toJenkinsJobPath
} from '../src/index.ts'

const builds = new Map<string, unknown>([
  [
    '/job/project/job/test-build/15/api/json',
    {
      number: 15,
      url: 'http://jenkins.local/job/project/job/test-build/15/',
      building: false,
      result: 'FAILURE',
      timestamp: 1782266400000,
      duration: 132000,
      artifacts: [
        { fileName: 'report.html', relativePath: 'reports/report.html' },
        { fileName: 'project-test.zip', relativePath: 'dist/project-test.zip' }
      ],
      actions: [
        {
          _class: 'hudson.model.ParametersAction',
          parameters: [
            { name: 'BRANCH', value: 'feature/demo' },
            { name: 'ENV', value: 'test' },
            { name: 'CHANNEL', value: 'default' },
            { name: 'GIT_COMMIT', value: 'abc1234' }
          ]
        },
        {
          causes: [{ userName: 'demo-user' }]
        }
      ]
    }
  ],
  [
    '/job/project/job/test-build/14/api/json',
    {
      number: 14,
      url: 'http://jenkins.local/job/project/job/test-build/14/',
      building: false,
      result: 'SUCCESS',
      timestamp: 1782262800000,
      duration: 95000,
      artifacts: [],
      actions: [
        {
          parameters: [
            { name: 'BRANCH', value: 'main' },
            { name: 'ENV', value: 'test' }
          ]
        }
      ]
    }
  ]
])

let baseUrl = ''
const httpServer = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url || '/', 'http://localhost')
  const path = url.pathname

  response.setHeader('Content-Type', 'application/json')

  if (path === '/api/json') {
    response.end(
      JSON.stringify({
        mode: 'NORMAL',
        nodeDescription: 'the Jenkins controller',
        useSecurity: true,
        jobs: [
          {
            name: 'project',
            url: `${baseUrl}/job/project/`,
            color: 'blue'
          }
        ]
      })
    )
    return
  }

  if (path === '/whoAmI/api/json') {
    response.end(JSON.stringify({ authenticated: true, name: 'demo-user', authorities: ['Job/Read', 'Run/Artifacts'] }))
    return
  }

  if (path === '/job/project/job/test-build/api/json') {
    response.end(
      JSON.stringify({
        name: 'test-build',
        fullName: 'project/test-build',
        url: `${baseUrl}/job/project/job/test-build/`,
        buildable: true,
        lastBuild: { number: 15, url: `${baseUrl}/job/project/job/test-build/15/` },
        lastSuccessfulBuild: { number: 14, url: `${baseUrl}/job/project/job/test-build/14/` },
        lastFailedBuild: { number: 15, url: `${baseUrl}/job/project/job/test-build/15/` },
        builds: [
          { number: 15, url: `${baseUrl}/job/project/job/test-build/15/` },
          { number: 14, url: `${baseUrl}/job/project/job/test-build/14/` }
        ]
      })
    )
    return
  }

  if (builds.has(path)) {
    response.end(JSON.stringify(builds.get(path)))
    return
  }

  if (path === '/job/project/job/test-build/15/consoleText') {
    response.setHeader('Content-Type', 'text/plain')
    response.end(
      [
        'Installing dependencies',
        'Authorization: Bearer sample-bearer-value',
        'Cookie: SESSION=sample-session-value',
        'Running build',
        'ERROR in src/main.ts: build failed',
        'Finished: FAILURE'
      ].join('\n')
    )
    return
  }

  if (path === '/queue/api/json') {
    response.end(JSON.stringify({ items: [{ id: 7, why: 'Waiting for next available executor' }] }))
    return
  }

  response.statusCode = 404
  response.end(JSON.stringify({ message: `not found: ${path}` }))
})

before(async () => {
  await new Promise<void>((resolve) => httpServer.listen(0, resolve))
  const address = httpServer.address()
  assert.ok(address && typeof address === 'object')
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => (error ? reject(error) : resolve()))
  })
})

test('converts folder paths into Jenkins job urls', () => {
  assert.equal(toJenkinsJobPath('project/test-build'), '/job/project/job/test-build')
})

test('checks Jenkins health with user and permissions', async () => {
  const client = createJenkinsClient({ baseUrl })

  const health = await client.healthCheck()

  assert.equal(health.ok, true)
  assert.equal(health.baseUrl, baseUrl)
  assert.equal(health.user, 'demo-user')
  assert.deepEqual(health.permissions, ['Job/Read', 'Run/Artifacts'])
})

test('reads job details and normalizes build references', async () => {
  const client = createJenkinsClient({ baseUrl })

  const job = await client.getJob('project/test-build')

  assert.equal(job.name, 'test-build')
  assert.equal(job.path, 'project/test-build')
  assert.equal(job.buildable, true)
  assert.equal(job.lastBuild?.number, 15)
  assert.equal(job.lastSuccessfulBuild?.number, 14)
  assert.equal(job.lastFailedBuild?.number, 15)
})

test('finds builds by branch and parameters', async () => {
  const client = createJenkinsClient({ baseUrl })

  const build = await client.findBuildByParams('project/test-build', {
    branch: 'feature/demo',
    env: 'test',
    channel: 'default'
  })

  assert.equal(build?.number, 15)
  assert.equal(build?.status, 'FAILURE')
  assert.equal(build?.branch, 'feature/demo')
  assert.equal(build?.commit, 'abc1234')
  assert.equal(build?.triggeredBy, 'demo-user')
})

test('redacts secrets and returns searchable log context', async () => {
  const client = createJenkinsClient({ baseUrl, log: { defaultTailLines: 4, maxChars: 2000 } })

  const log = await client.searchBuildLog('project/test-build', 15, 'ERROR', 1)

  assert.equal(log.matches.length, 1)
  assert.match(log.text, /ERROR in src\/main.ts/)
  assert.doesNotMatch(log.text, /sample-bearer-value/)
  assert.doesNotMatch(log.text, /sample-session-value/)
  assert.match(redactSecrets('token=abc123\npassword: very-secret'), /token=\[REDACTED\]/)
})

test('lists artifacts with download urls and type labels', async () => {
  const client = createJenkinsClient({ baseUrl })

  const artifacts = await client.listArtifacts('project/test-build', 15)

  assert.deepEqual(
    artifacts.map((artifact) => [artifact.name, artifact.type]),
    [
      ['report.html', 'html-report'],
      ['project-test.zip', 'package']
    ]
  )
  assert.equal(artifacts[0]?.url, `${baseUrl}/job/project/job/test-build/15/artifact/reports/report.html`)
})

test('creates a Loop-ready verification report from Jenkins data', async () => {
  const client = createJenkinsClient({ baseUrl, log: { defaultTailLines: 4, maxChars: 2000 } })

  const report = await createVerificationReport(client, {
    jobPath: 'project/test-build',
    buildNumber: 15,
    logKeyword: 'ERROR'
  })

  assert.equal(report.conclusion, '失败')
  assert.equal(report.shouldBlock, true)
  assert.equal(report.job.path, 'project/test-build')
  assert.equal(report.build?.number, 15)
  assert.match(report.summary, /构建失败/)
  assert.equal(report.artifacts.length, 2)
  assert.match(report.logHighlights[0]?.text || '', /ERROR in src\/main.ts/)
  assert.doesNotMatch(JSON.stringify(report), /sample-bearer-value|sample-session-value/)
})
