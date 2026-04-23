# swagger-mcp-server-z

An MCP server built on Swagger docs, used in coding tools to **query API definitions, parameters, and response structure overviews**, so Agents / developers can quickly align on endpoint details.

## 1. Use via configuration (no install required)

This project is intended to be run via **npx**. You don't need to `npm i` it in your repo.

## 2. Configure MCP (pass Swagger info via CLI args)

Add one server entry to your tool's MCP configuration (the server key can follow your team convention, e.g. `swagger` or `swagger-mcp-server-z`), then pass Swagger URLs and auth info via CLI arguments.

### 2.1 Cursor example

Add to `.cursor/mcp.json`:

```jsonc
{
  "mcpServers": {
    "swagger-mcp-server-z": {
      "command": "npx",
      "args": [
        "-y",
        "swagger-mcp-server-z",
        "--swaggerUrls=https://api.example.com/api/doc/swagger.json,https://api2.example.com/api/doc/swagger.json",
        "--swaggerUser=demo_user",
        "--swaggerPassword=demo_password"
      ],
      "env": {}
    }
  }
}
```

> The paths and credentials above are placeholders. Replace them with real values from your own Swagger environment, and avoid committing sensitive data (username/password/cookie) to the repository.

### 2.2 Trae example

Add this to Trae's MCP config (the structure is similar to Cursor; the key is `command: npx` + `args`):

```jsonc
{
  "mcpServers": {
    "swagger-mcp-server-z": {
      "command": "npx",
      "args": [
        "-y",
        "swagger-mcp-server-z",
        "--swaggerUrls=https://api.example.com/api/doc/swagger.json",
        "--swaggerUser=demo_user",
        "--swaggerPassword=demo_password"
      ]
    }
  }
}
```

### 2.3 Claude Code example

Add this to Claude Code's MCP config (also launched via `npx`):

```jsonc
{
  "mcpServers": {
    "swagger-mcp-server-z": {
      "command": "npx",
      "args": [
        "-y",
        "swagger-mcp-server-z",
        "--swaggerUrls=https://api.example.com/api/doc/swagger.json",
        "--swaggerUser=demo_user",
        "--swaggerPassword=demo_password"
      ]
    }
  }
}
```

### 2.4 Supported CLI Arguments

- `--swaggerUrls` (required): Comma-separated list of Swagger JSON URLs  
  - Example: `--swaggerUrls=https://a/swagger.json,https://b/swagger.json`
- `--swaggerUser` (required): Swagger login username
- `--swaggerPassword` (required): Swagger login password
- `--swaggerCookie` (optional): Full `cookie` string if you want to reuse an existing login session

Alias compatibility (choose any one in each group):

- `swaggerUrls` can also be `swaggerUrl` / `urls`
- `swaggerPassword` can also be `swaggerPass` / `password`
- `swaggerCookie` can also be `cookie`
- `swaggerUser` can also be `user`

After updating, in Cursor:

- Settings → Features → MCP → ensure `swagger-mcp-server-z` is enabled
- Reload Window if needed

## 3. Tools Provided

### 4.1 `swagger_list_operations`

- **Description**: Lists endpoint definitions from Swagger docs, with optional filters by path/method/tag/summary. Useful for quickly seeing what APIs are available and their brief descriptions.
- **Input parameters**:
  - `path_contains` (optional): Filter by path substring, e.g. `running_task`.
  - `method` (optional): `GET` / `POST` / `PUT` / `DELETE` / `PATCH` / `OPTIONS` / `HEAD`.
  - `tag` (optional): Filter by Swagger tag.
  - `summary_contains` (optional): Filter by keyword in summary/description.
  - `force_refresh` (optional, boolean): Whether to force refetch Swagger JSON.
- **Output**: A list of operations, each including:
  - `path`
  - `method`
  - `operationId`
  - `summary`
  - `description`
  - `tags`

### 4.2 `swagger_get_operation`

- **Description**: Queries a single operation in detail by `path + method` or `operationId`, including parameter list and response structure overview.
- **Input parameters** (choose one mode):
  - By `operationId`:
    - `operationId`: operationId defined in Swagger;
  - By `path + method`:
    - `path`: e.g. `/running_task`;
    - `method`: `GET` / `POST` / `PUT` / `DELETE` / `PATCH` / `OPTIONS` / `HEAD`;
  - Common:
    - `force_refresh` (optional, boolean): Whether to force refetch Swagger JSON.
- **Output**:
  - `path`
  - `method`
  - `operationId`
  - `summary`
  - `description`
  - `tags`
  - `parameters`: array containing:
    - `name`
    - `in` (query/path/header/body, etc.)
    - `required`
    - `description`
    - `type`
    - `schemaRef` (if it is a `$ref`)
  - `responses`: organized by HTTP status code, containing:
    - `description`
    - `schemaRef`
    - `type`

## 4. Typical Usage

- **Browse all `running_task`-related APIs**:
  - Call `swagger_list_operations` with: `{ "path_contains": "running_task" }`
- **Inspect API parameters by operationId**:
  - Call `swagger_get_operation` with: `{ "operationId": "RunningTask_List" }`
- **Inspect by path + method**:
  - Call `swagger_get_operation` with: `{ "path": "/running_task", "method": "GET" }`
