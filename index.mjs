#!/usr/bin/env node
/**
 * swagger-mcp - Swagger / OpenAPI 文档查询 MCP 服务器
 * 功能：
 *   - 从项目 Swagger 文档获取接口定义（paths + schemas）
 *   - 按路径/方法/operationId/标签搜索接口
 *   - 查看单个接口的参数、请求体与响应结构概览
 *
 * 认证：
 *   - 复用技能 swagger-to-api-model 的 .env：
 *     .cursor/skills/swagger-to-api-model/.env
 *     需要配置：
 *       SWAGGER_USER=xxx
 *       SWAGGER_PASSWORD=yyy
 */

import { z } from 'zod'
import axios from 'axios'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// ---------- 配置与 HTTP ----------
function parseCliArgs() {
  const args = process.argv.slice(2)
  const map = {}

  for (const arg of args) {
    if (!arg.startsWith('--')) continue
    const trimmed = arg.slice(2)
    const eqIndex = trimmed.indexOf('=')
    if (eqIndex === -1) {
      map[trimmed] = 'true'
    } else {
      const key = trimmed.slice(0, eqIndex)
      const value = trimmed.slice(eqIndex + 1)
      map[key] = value
    }
  }

  return map
}

function loadSwaggerConfig() {
  const cli = parseCliArgs()

  // swaggerUrls 支持逗号分隔：--swaggerUrls=url1,url2
  const urlsRaw = cli.swaggerUrls || cli.swaggerUrl || cli.urls
  const swaggerUrls = urlsRaw
    ? String(urlsRaw)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    : []

  const user = cli.swaggerUser || cli.user
  const password = cli.swaggerPassword || cli.swaggerPass || cli.password
  const cookie = cli.swaggerCookie || cli.cookie || ''

  if (!swaggerUrls.length) {
    process.stderr.write(
      JSON.stringify({
        error: '缺少 swaggerUrls 参数',
        hint:
          '请通过命令行传入 swaggerUrls，例如：node index.mjs --swaggerUrls=https://a/swagger.json,https://b/swagger.json',
      }) + '\n'
    )
    process.exit(1)
  }

  if (!user || !password) {
    process.stderr.write(
      JSON.stringify({
        error: '缺少 swaggerUser 或 swaggerPassword 参数',
        hint: '请通过命令行传入 swaggerUser 与 swaggerPassword，例如：node index.mjs --swaggerUser=xxx --swaggerPassword=yyy',
      }) + '\n'
    )
    process.exit(1)
  }

  return { swaggerUrls, swaggerAuth: { user, password, cookie } }
}

const { swaggerUrls, swaggerAuth } = loadSwaggerConfig()

const http = axios.create({
  timeout: 30000,
  validateStatus: () => true,
})

// ---------- 通用工具 ----------
const json = (_x) => JSON.stringify(_x, null, 2)

function textResult(_text) {
  return { content: [{ type: 'text', text: _text }] }
}

function textError(_msg) {
  return { content: [{ type: 'text', text: `错误: ${_msg}` }], isError: true }
}

// ---------- Swagger 加载与解析 ----------
let swaggerCache = null
let swaggerCacheTs = 0
const swaggerCacheTtlMs = 5 * 60 * 1000

async function fetchSwagger(_force = false) {
  const now = Date.now()
  if (!_force && swaggerCache && now - swaggerCacheTs < swaggerCacheTtlMs) {
    return swaggerCache
  }

  function buildRefererFromSwaggerUrl(swaggerUrl) {
    try {
      const u = new URL(swaggerUrl)
      const p = u.pathname || '/'
      const lowered = p.toLowerCase()

      // 常见 swagger json 路径：
      // - /api/doc/swagger.json        -> referer: /api/doc
      // - /swagger/v1/swagger.json     -> referer: /swagger/v1
      // - /v3/api-docs                -> referer: origin
      if (lowered.endsWith('/api/doc/swagger.json')) return `${u.origin}/api/doc`

      // swagger.json 通用：去掉最后一个 segment 当作目录
      if (lowered.endsWith('/swagger.json')) {
        const dir = p.replace(/\/swagger\.json$/i, '') || '/'
        return `${u.origin}${dir}`
      }

      // 兜底：只返回 origin，避免硬编码任何环境域名/路径
      return u.origin
    } catch {
      // 无效 URL 则不设置 referer
      return ''
    }
  }

  const results = []
  for (const url of swaggerUrls) {
    const referer = buildRefererFromSwaggerUrl(url)
    const res = await http.get(url, {
      headers: {
        accept: 'application/json,*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
        authorization: 'Basic ' + Buffer.from(`${swaggerAuth.user}:${swaggerAuth.password}`).toString('base64'),
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        priority: 'u=1, i',
        'sec-ch-ua': '"Not)A;Brand";v="8", "Chromium";v="138", "Google Chrome";v="138"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        // 避免在仓库中硬编码真实环境域名：根据 swagger url 动态生成 referer
        ...(referer ? { Referer: referer } : {}),
        ...(swaggerAuth.cookie
          ? {
              cookie: swaggerAuth.cookie,
            }
          : {}),
      },
    })
    if (res.status !== 200) {
      console.log('res.data:', res.data)
      throw new Error(`拉取 Swagger 失败: ${url} - ${res.status} - ${JSON.stringify(res.data).slice(0, 500)}`)
    }
    results.push(res.data)
  }

  swaggerCache = results
  swaggerCacheTs = now
  return swaggerCache
}

function eachOperation(_swagger, _cb) {
  const paths = _swagger.paths || {}
  const httpMethods = ['get', 'post', 'put', 'delete', 'patch', 'options', 'head']
  for (const [path, item] of Object.entries(paths)) {
    for (const method of httpMethods) {
      const op = item?.[method]
      if (!op) continue
      _cb({
        path,
        method: method.toUpperCase(),
        operation: op,
      })
    }
  }
}

function summarizeOperation(_path, _method, _op) {
  return {
    path: _path,
    method: _method,
    operationId: _op.operationId || null,
    summary: _op.summary || null,
    description: _op.description || null,
    tags: Array.isArray(_op.tags) ? _op.tags : [],
  }
}

function normalizeParameters(_op, _globalParams = []) {
  const params = []
  const globalList = Array.isArray(_globalParams)
    ? _globalParams
    : _globalParams && typeof _globalParams === 'object'
      ? Object.values(_globalParams)
      : []
  const all = [...globalList, ...(_op.parameters || [])]
  for (const p of all) {
    params.push({
      name: p.name,
      in: p.in,
      required: !!p.required,
      description: p.description || null,
      type: p.type || (p.schema && p.schema.type) || null,
      schemaRef: p.schema && p.schema.$ref ? p.schema.$ref : null,
    })
  }
  return params
}

function normalizeResponses(_op) {
  const res = {}
  const responses = _op.responses || {}
  for (const [code, r] of Object.entries(responses)) {
    res[code] = {
      description: r.description || null,
      schemaRef: r.schema && r.schema.$ref ? r.schema.$ref : null,
      type: r.schema && r.schema.type ? r.schema.type : null,
    }
  }
  return res
}

// ---------- MCP Server ----------
const server = new McpServer({ name: 'swagger-mcp', version: '1.0.0' }, { capabilities: { tools: {} } })

// 列出接口（支持过滤）
server.registerTool(
  'swagger_list_operations',
  {
    description:
      '从 Swagger 文档中列出接口定义，可按路径/方法/tag/summary 过滤。用于浏览有哪些接口以及简介。',
    inputSchema: z.object({
      path_contains: z.string().optional().describe('按路径包含过滤，如 running_task'),
      method: z
        .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])
        .optional()
        .describe('按 HTTP 方法过滤'),
      tag: z.string().optional().describe('按 tag 过滤'),
      summary_contains: z.string().optional().describe('按 summary/description 关键字过滤'),
      force_refresh: z.boolean().optional().describe('是否强制重新拉取 Swagger JSON'),
    }),
  },
  async (_args) => {
    try {
      const swaggers = await fetchSwagger(_args?.force_refresh)
      const out = []
      for (const swagger of swaggers) {
        eachOperation(swagger, ({ path, method, operation }) => {
          const item = summarizeOperation(path, method, operation)
          if (_args?.method && item.method !== _args.method) return
          if (_args?.path_contains && !item.path.includes(_args.path_contains)) return
          if (_args?.tag && !item.tags.includes(_args.tag)) return
          if (_args?.summary_contains) {
            const text = `${item.summary || ''} ${item.description || ''}`
            if (!text.includes(_args.summary_contains)) return
          }
          out.push(item)
        })
      }
      return textResult(json(out))
    } catch (_err) {
      return textError(_err.message || String(_err))
    }
  }
)

// 查询单个接口详情：参数、响应等
server.registerTool(
  'swagger_get_operation',
  {
    description:
      '根据 path+method 或 operationId 查询单个接口的详细定义，包括参数列表与响应结构概览。',
    inputSchema: z
      .object({
        path: z.string().describe('接口路径，如 /running_task').optional(),
        method: z
          .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])
          .describe('HTTP 方法')
          .optional(),
        operationId: z.string().describe('Swagger operationId').optional(),
        force_refresh: z.boolean().optional().describe('是否强制重新拉取 Swagger JSON'),
      })
      .refine(
        (v) =>
          (!!v.operationId && !v.path && !v.method) ||
          (!!v.path && !!v.method && !v.operationId),
        '需要 (operationId) 或 (path + method) 其一'
      ),
  },
  async (_args) => {
    try {
      const swaggers = await fetchSwagger(_args?.force_refresh)
      const result = []

      if (_args.operationId) {
        for (const swagger of swaggers) {
          eachOperation(swagger, ({ path, method, operation }) => {
            if (operation.operationId === _args.operationId) {
              result.push({
                ...summarizeOperation(path, method, operation),
                parameters: normalizeParameters(operation, swagger.parameters),
                responses: normalizeResponses(operation),
              })
            }
          })
        }
      } else if (_args.path && _args.method) {
        const targetPath = _args.path
        const methodKey = _args.method.toLowerCase()
        let found = false

        for (const swagger of swaggers) {
          const item = swagger.paths?.[targetPath]
          const op = item?.[methodKey]
          if (!op) continue
          result.push({
            ...summarizeOperation(targetPath, _args.method, op),
            parameters: normalizeParameters(op, swagger.parameters),
            responses: normalizeResponses(op),
          })
          found = true
        }

        if (!found) {
          return textError(`未找到接口: ${_args.method} ${_args.path}`)
        }
      }

      if (!result.length) {
        return textError('未匹配到任何接口定义，请检查 path/method 或 operationId 是否正确')
      }
      return textResult(json(result.length === 1 ? result[0] : result))
    } catch (_err) {
      return textError(_err.message || String(_err))
    }
  }
)

await server.connect(new StdioServerTransport())

