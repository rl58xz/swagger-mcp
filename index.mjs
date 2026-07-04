#!/usr/bin/env node
/**
 * swagger-mcp-server-z - Swagger / OpenAPI 文档查询 MCP 服务器
 * 功能：
 *   - 从项目 Swagger 文档获取接口定义（paths + schemas）
 *   - 按路径/方法/operationId/标签搜索接口
 *   - 查看单个接口的参数、请求体与响应结构概览
 *
 * 认证：
 *   - 需要配置：
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

  const user = cli.swaggerUser || cli.user || ''
  const password = cli.swaggerPassword || cli.swaggerPass || cli.password || ''
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

  if ((user && !password) || (!user && password)) {
    process.stderr.write(
      JSON.stringify({
        error: 'swaggerUser 与 swaggerPassword 必须同时提供',
        hint: '公开 Swagger 可以只传 swaggerUrls；需要 Basic Auth 时同时传 swaggerUser 与 swaggerPassword',
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
    const basicAuthHeader =
      swaggerAuth.user && swaggerAuth.password
        ? {
            authorization: 'Basic ' + Buffer.from(`${swaggerAuth.user}:${swaggerAuth.password}`).toString('base64'),
          }
        : {}
    const res = await http.get(url, {
      headers: {
        accept: 'application/json,*/*',
        'accept-language': 'zh-CN,zh;q=0.9',
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
        ...basicAuthHeader,
        ...(swaggerAuth.cookie
          ? {
              cookie: swaggerAuth.cookie,
            }
          : {}),
      },
    })
    if (res.status !== 200) {
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
    const schema = r?.schema || r?.content?.['application/json']?.schema || r?.content?.['*/*']?.schema || null
    res[code] = {
      description: r.description || null,
      schemaRef: schema && schema.$ref ? schema.$ref : null,
      type: schema && schema.type ? schema.type : null,
      schema: schema || null,
    }
  }
  return res
}

function normalizeRequestBody(_swagger, _op) {
  // OpenAPI 3.x: operation.requestBody
  if (_op?.requestBody && typeof _op.requestBody === 'object') {
    const rb = _op.requestBody
    return {
      required: !!rb.required,
      description: rb.description || null,
      content: rb.content && typeof rb.content === 'object' ? rb.content : {},
    }
  }

  // Swagger 2.0: body parameter (in: body)
  const bodyParam = Array.isArray(_op?.parameters) ? _op.parameters.find((p) => p && p.in === 'body') : null
  if (bodyParam && typeof bodyParam === 'object') {
    const schema = bodyParam.schema || null
    const consumes = Array.isArray(_op?.consumes)
      ? _op.consumes
      : Array.isArray(_swagger?.consumes)
        ? _swagger.consumes
        : []
    const contentTypes = consumes.length ? consumes : ['application/json']
    const content = {}
    for (const ct of contentTypes) {
      content[ct] = { schema }
    }
    return {
      required: !!bodyParam.required,
      description: bodyParam.description || null,
      content,
    }
  }

  return null
}

function getSwaggerSchemas(_swagger) {
  const openapi3 = _swagger?.components?.schemas
  if (openapi3 && typeof openapi3 === 'object') return openapi3
  const swagger2 = _swagger?.definitions
  if (swagger2 && typeof swagger2 === 'object') return swagger2
  return {}
}

function parseSchemaRefName(_ref) {
  if (!_ref || typeof _ref !== 'string') return null
  const parts = _ref.split('/')
  return parts.length ? parts[parts.length - 1] : null
}

function normalizeSchemaNode(_node) {
  if (!_node || typeof _node !== 'object') return null
  const out = {}
  if (_node.title) out.title = _node.title
  if (_node.description) out.description = _node.description
  if (_node.type) out.type = _node.type
  if (_node.format) out.format = _node.format
  if (_node.enum) out.enum = _node.enum
  if (_node.nullable != null) out.nullable = _node.nullable
  if (_node.default != null) out.default = _node.default
  if (_node.example != null) out.example = _node.example
  return out
}

function resolveSchema(_swagger, _schema, _ctx = {}) {
  const maxDepth = 12
  const depth = _ctx.depth || 0
  const seenRefs = _ctx.seenRefs || new Set()
  const schemas = _ctx.schemas || getSwaggerSchemas(_swagger)

  if (!_schema) return null
  if (depth > maxDepth) return { type: 'object', description: 'Max depth reached' }

  // $ref
  if (_schema.$ref) {
    const ref = _schema.$ref
    const name = parseSchemaRefName(ref)
    if (!name) return { $ref: ref }
    if (seenRefs.has(ref)) return { $ref: ref, circular: true }
    const target = schemas?.[name]
    if (!target) return { $ref: ref, missing: true }
    const nextSeen = new Set(seenRefs)
    nextSeen.add(ref)
    const resolved = resolveSchema(_swagger, target, { depth: depth + 1, seenRefs: nextSeen, schemas })
    return { ...resolved, $ref: ref, refName: name }
  }

  // allOf / oneOf / anyOf
  if (Array.isArray(_schema.allOf) && _schema.allOf.length) {
    return {
      ...normalizeSchemaNode(_schema),
      allOf: _schema.allOf.map((s) => resolveSchema(_swagger, s, { depth: depth + 1, seenRefs, schemas })),
    }
  }
  if (Array.isArray(_schema.oneOf) && _schema.oneOf.length) {
    return {
      ...normalizeSchemaNode(_schema),
      oneOf: _schema.oneOf.map((s) => resolveSchema(_swagger, s, { depth: depth + 1, seenRefs, schemas })),
    }
  }
  if (Array.isArray(_schema.anyOf) && _schema.anyOf.length) {
    return {
      ...normalizeSchemaNode(_schema),
      anyOf: _schema.anyOf.map((s) => resolveSchema(_swagger, s, { depth: depth + 1, seenRefs, schemas })),
    }
  }

  // array
  if (_schema.type === 'array' || _schema.items) {
    return {
      ...normalizeSchemaNode(_schema),
      type: 'array',
      items: resolveSchema(_swagger, _schema.items || {}, { depth: depth + 1, seenRefs, schemas }),
    }
  }

  // object
  const hasProps = _schema.properties && typeof _schema.properties === 'object'
  const hasAdditional = _schema.additionalProperties != null
  if (_schema.type === 'object' || hasProps || hasAdditional) {
    const props = {}
    if (hasProps) {
      for (const [k, v] of Object.entries(_schema.properties)) {
        props[k] = resolveSchema(_swagger, v, { depth: depth + 1, seenRefs, schemas })
      }
    }
    let additionalProperties = undefined
    if (hasAdditional) {
      additionalProperties =
        _schema.additionalProperties === true
          ? true
          : _schema.additionalProperties === false
            ? false
            : resolveSchema(_swagger, _schema.additionalProperties, { depth: depth + 1, seenRefs, schemas })
    }
    const required = Array.isArray(_schema.required) ? _schema.required : []
    const out = { ...normalizeSchemaNode(_schema), type: 'object', required, properties: props }
    if (additionalProperties !== undefined) out.additionalProperties = additionalProperties
    return out
  }

  // primitive or unknown
  return normalizeSchemaNode(_schema) || _schema
}

function resolveOperationResponses(_swagger, _op) {
  const base = normalizeResponses(_op)
  const out = {}
  for (const [code, r] of Object.entries(base)) {
    const schemaResolved = r.schema ? resolveSchema(_swagger, r.schema, { depth: 0, seenRefs: new Set() }) : null
    out[code] = { ...r, schemaResolved }
  }
  return out
}

function resolveOperationRequestBody(_swagger, _op) {
  const rb = normalizeRequestBody(_swagger, _op)
  if (!rb) return null

  const content = rb.content && typeof rb.content === 'object' ? rb.content : {}
  const schema =
    content?.['application/json']?.schema ||
    content?.['*/*']?.schema ||
    Object.values(content).find((v) => v && typeof v === 'object' && v.schema)?.schema ||
    null
  const schemaResolved = schema ? resolveSchema(_swagger, schema, { depth: 0, seenRefs: new Set() }) : null

  return {
    ...rb,
    schemaRef: schema && schema.$ref ? schema.$ref : null,
    schema,
    schemaResolved,
  }
}

// ---------- MCP Server ----------
const server = new McpServer({ name: 'swagger-mcp-server-z', version: '1.0.0' }, { capabilities: { tools: {} } })

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
      '根据 path+method 或 operationId 查询单个接口的详细定义（参数、请求体、响应概览）。path 必须为 Swagger paths 中的完整路径字符串（含前缀斜杠），不要用路径关键字片段；若只知道关键字请先用 swagger_list_operations 查到完整 path 再调用本工具。',
    inputSchema: z
      .object({
        path: z.string().describe('接口路径，如 /running_task（与 Swagger paths 键一致）').optional(),
        method: z
          .enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'])
          .describe('HTTP 方法')
          .optional(),
        operationId: z.string().describe('Swagger operationId').optional(),
        force_refresh: z.boolean().optional().describe('是否强制重新拉取 Swagger JSON'),
      })
      .passthrough()
      .refine(
        (v) =>
          (!!v.operationId && !v.path && !v.method) ||
          (!!v.path && !!v.method && !v.operationId) ||
          (!!v.path_contains && !!v.method && !v.operationId && !v.path),
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
                requestBody: resolveOperationRequestBody(swagger, operation),
                responses: resolveOperationResponses(swagger, operation),
              })
            }
          })
        }
        if (!result.length) {
          return textError(
            `当前文档中不存在 operationId「${_args.operationId}」。请核对拼写是否与 Swagger 一致；若不确定名称，可先用 swagger_list_operations 按路径或摘要筛选。`
          )
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
            requestBody: resolveOperationRequestBody(swagger, op),
            responses: resolveOperationResponses(swagger, op),
          })
          found = true
        }

        if (!found) {
          return textError(
            `未找到 ${_args.method} ${_args.path}。path 须与 Swagger paths 中的键完全一致（含是否带前缀 /、大小写）。可用 swagger_list_operations 对照文档中的完整路径后重试。`
          )
        }
      } else if (_args.path_contains && _args.method) {
        // 兼容误传：将 path_contains 视为 path，进行严格匹配（不做 includes 模糊命中）
        const targetPath = _args.path_contains
        const methodKey = _args.method.toLowerCase()
        let found = false

        for (const swagger of swaggers) {
          const item = swagger.paths?.[targetPath]
          const op = item?.[methodKey]
          if (!op) continue
          result.push({
            ...summarizeOperation(targetPath, _args.method, op),
            parameters: normalizeParameters(op, swagger.parameters),
            requestBody: resolveOperationRequestBody(swagger, op),
            responses: resolveOperationResponses(swagger, op),
          })
          found = true
        }

        if (!found) {
          return textError(
            `未找到 ${_args.method} ${targetPath}。请注意：这里是兼容误传参数；该值仍需为 Swagger paths 中的完整路径（非关键字片段）。建议先用 swagger_list_operations 找到完整 path 后，再用 path+method 调用。`
          )
        }
      }

      if (!result.length) {
        return textError(
          '未能匹配到接口定义。请确认参数符合工具约定（operationId 单独传入，或 path 与 method 成对且 path 为文档中的完整路径），必要时先用 swagger_list_operations 检索。'
        )
      }
      return textResult(json(result.length === 1 ? result[0] : result))
    } catch (_err) {
      return textError(_err.message || String(_err))
    }
  }
)

server.registerTool(
  'swagger_resolve_schema_ref',
  {
    description:
      '根据 schemaRef（如 #/components/schemas/X 或 #/definitions/X）解析并返回完整 schema 结构，递归展开 $ref。',
    inputSchema: z.object({
      schemaRef: z.string().describe('Schema 引用，如 #/components/schemas/ResponseDto'),
      swaggerIndex: z.number().min(0).optional().describe('多 Swagger 源时指定索引（默认 0）'),
      force_refresh: z.boolean().optional().describe('是否强制重新拉取 Swagger JSON'),
    }),
  },
  async (_args) => {
    try {
      const swaggers = await fetchSwagger(_args?.force_refresh)
      const index = _args?.swaggerIndex != null ? _args.swaggerIndex : 0
      const swagger = swaggers[index]
      if (!swagger) return textError(`swaggerIndex 无效: ${index}`)

      const name = parseSchemaRefName(_args.schemaRef)
      if (!name) return textError('schemaRef 无法解析，请传入形如 #/components/schemas/X 的引用')

      const schemas = getSwaggerSchemas(swagger)
      const target = schemas?.[name]
      if (!target) return textError(`未找到 schema: ${name}`)

      const resolved = resolveSchema(swagger, { $ref: _args.schemaRef }, { depth: 0, seenRefs: new Set() })
      return textResult(json(resolved))
    } catch (_err) {
      return textError(_err.message || String(_err))
    }
  }
)

await server.connect(new StdioServerTransport())
