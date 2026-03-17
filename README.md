# swagger-mcp

基于项目 Swagger 文档的 MCP 服务器，用于在 Cursor 中**查询接口定义和参数**，方便 Agent/人类查看接口说明、参数与响应结构概览。

## 1. 安装依赖

在项目根目录执行：

```bash
cd .cursor/swagger-mcp && npm install
```

## 2. 在 Cursor 中配置 MCP（命令行参数）

在 `.cursor/mcp.json` 中新增（名称可根据团队习惯调整，如 `swagger` 或 `swagger-mcp`），并通过命令行参数传入 Swagger 地址和账号信息：

```jsonc
{
  "mcpServers": {
    "swagger-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "swagger-mcp",
        "--swaggerUrls=https://api.example.com/api/doc/swagger.json,https://api2.example.com/api/doc/swagger.json",
        "--swaggerUser=demo_user",
        "--swaggerPassword=demo_password",
        "--swaggerCookie=sessionid=demo_session_id; token=demo_token"
      ],
      "env": {}
    }
  }
}
```

> 上述路径与账号信息均为示例占位，请替换为你自己的 Swagger 环境实际值（避免在仓库中提交真实账号/密码/cookie 等敏感信息）。

### 2.1 支持的命令行参数

- `--swaggerUrls`（必填）：逗号分隔的 Swagger JSON 地址列表  
  - 例：`--swaggerUrls=https://a/swagger.json,https://b/swagger.json`
- `--swaggerUser`（必填）：Swagger 登录用户名
- `--swaggerPassword`（必填）：Swagger 登录密码
- `--swaggerCookie`（可选）：如果需要复用登录态，可传入完整 `cookie` 字符串

别名兼容（任选其一即可）：

- `swaggerUrls` 也可用 `swaggerUrl` / `urls`
- `swaggerPassword` 也可用 `swaggerPass` / `password`
- `swaggerCookie` 也可用 `cookie`
- `swaggerUser` 也可用 `user`

更新后在 Cursor 中打开：

- Settings → Features → MCP → 确认 `swagger-mcp` 已启用
- 如有需要可 Reload Window

## 4. 提供的工具

### 4.1 `swagger_list_operations`

- **说明**：从 Swagger 文档中列出接口定义，可按路径/方法/tag/summary 过滤。用于快速浏览“有哪些接口”及其简介。
- **输入参数**：
  - `path_contains` (可选)：按路径包含过滤，例如 `running_task`。
  - `method` (可选)：`GET` / `POST` / `PUT` / `DELETE` / `PATCH` / `OPTIONS` / `HEAD`。
  - `tag` (可选)：按 Swagger tag 过滤。
  - `summary_contains` (可选)：按 summary/description 中的关键词过滤。
  - `force_refresh` (可选，布尔)：是否强制重新拉取 Swagger JSON。
- **输出**：接口列表，每项包含：
  - `path`
  - `method`
  - `operationId`
  - `summary`
  - `description`
  - `tags`

### 4.2 `swagger_get_operation`

- **说明**：根据 `path + method` 或 `operationId` 查询单个接口的详细定义，包括参数列表与响应结构概览。
- **输入参数**（二选一）：
  - 使用 `operationId`：
    - `operationId`：Swagger 中的 operationId；
  - 使用 `path + method`：
    - `path`：如 `/running_task`；
    - `method`：`GET` / `POST` / `PUT` / `DELETE` / `PATCH` / `OPTIONS` / `HEAD`；
  - 通用：
    - `force_refresh` (可选，布尔)：是否强制重新拉取 Swagger JSON。
- **输出**：
  - `path`
  - `method`
  - `operationId`
  - `summary`
  - `description`
  - `tags`
  - `parameters`：数组，含：
    - `name`
    - `in`（query/path/header/body 等）
    - `required`
    - `description`
    - `type`
    - `schemaRef`（如果是 `$ref`）
  - `responses`：按 HTTP 状态码组织，含：
    - `description`
    - `schemaRef`
    - `type`

## 5. 典型使用方式

- **浏览所有 running_task 相关接口**：
  - 调用 `swagger_list_operations`，参数：`{ "path_contains": "running_task" }`
- **按 operationId 查看接口参数**：
  - 调用 `swagger_get_operation`，参数：`{ "operationId": "RunningTask_List" }`
- **按路径 + 方法查看**：
  - 调用 `swagger_get_operation`，参数：`{ "path": "/running_task", "method": "GET" }`

建议在实现/调整业务接口前，先用 `swagger_list_operations` + `swagger_get_operation` 组合获取接口说明，再通过现有 `swagger-to-api-model` 技能生成 `api.ts` 和 `model.ts`。

