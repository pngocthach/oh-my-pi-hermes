# Implementation Decisions

Ngày cập nhật: 2026-08-07

Tài liệu này ghi lại các quyết định implement đã thống nhất cho project biến `oh-my-pi` thành Hermes-style agent gateway, cùng những điểm đã được kiểm chứng bằng smoke test thực tế.

Nguồn kiến trúc ban đầu: [`RESEARCH.md`](./RESEARCH.md).

## 1. Mục tiêu

Xây một gateway độc lập quanh `oh-my-pi`, cung cấp hai adapter:

- Discord adapter.
- OpenAI-compatible HTTP/SSE adapter để Open WebUI kết nối.

Không port toàn bộ Hermes Agent. Không fork hoặc sửa Open WebUI.

## 2. Kiến trúc đã chọn

```text
Discord adapter ───────┐
                       ├── SessionWorkerPool ── JSONL stdin/stdout ── omp --mode rpc
OpenAI/SSE adapter ────┘
```

### 2.1 Agent core

- Agent core: `oh-my-pi`.
- Gateway không import SDK trực tiếp.
- Gateway không import `rpc-client.ts` hoặc các type nội bộ của `oh-my-pi`.
- Gateway chỉ phụ thuộc vào wire protocol JSONL độc lập.

Lý do: có thể cập nhật binary `omp` mà không bắt buộc build lại gateway, miễn RPC protocol vẫn backward-compatible.

### 2.2 Process model

- Mỗi external conversation có một `omp` worker process riêng.
- Gateway giữ `SessionWorkerPool`:

```text
external conversation ID -> child process + stdin/stdout reader
```

Session key đề xuất:

```text
discord:<guild>:<channel>:<thread-or-user>
openwebui:<conversation-id>
```

Không dùng chung một RPC process cho nhiều conversation độc lập nếu chưa có multiplexing layer riêng.

### 2.3 Các module chính

Cấu trúc dự kiến:

```text
gateway/
  session-worker.ts
  session-worker-pool.ts
  rpc-transport.ts
  discord-adapter.ts
  openai-server.ts
  message-format.ts
```

Có thể tổ chức lại dưới `src/`, nhưng phải giữ các boundary trên.

## 3. Stack Better T Stack

Stack scaffold được chốt cho phiên bản đầu:

| Thành phần | Quyết định |
|---|---|
| Runtime | Bun |
| Backend | Hono |
| Frontend | None |
| Database | None |
| ORM | None |
| API layer | None |
| Auth framework | None |
| Package manager | Bun |
| Examples | None |
| Deployment | Native host hoặc Docker cùng môi trường với `omp` |

Lệnh scaffold đề xuất:

```bash
bunx create-better-t-stack@latest hermes-gateway \
  --frontend none \
  --backend hono \
  --runtime bun \
  --database none \
  --orm none \
  --api none \
  --auth none \
  --package-manager bun \
  --examples none \
  --db-setup none
```

### 3.1 Lý do không dùng database ngay

`oh-my-pi` đã sở hữu agent session persistence. Session mặc định được lưu qua `SessionManager` và `FileSessionStorage`, dạng JSONL.

Gateway không cần mirror transcript vào database.

Gateway chỉ cần quản lý metadata riêng:

```text
external conversation ID -> omp sessionFile
```

Phiên bản đầu có thể dùng:

- In-memory map cho worker đang chạy.
- File JSON nhỏ hoặc directory convention cho mapping bền vững.
- Session directory riêng cho từng conversation.

Ví dụ:

```text
var/
  gateway-sessions.json
  omp-sessions/
    discord-<hash>/
    openwebui-<hash>/
```

Có thể thêm database sau mà không đổi agent session model. Chỉ thêm PostgreSQL/Drizzle hoặc Redis khi cần multi-instance, durable retry, analytics, lease/lock hoặc coordination giữa nhiều host.

### 3.2 Lý do không dùng Workers

Cloudflare Workers không phù hợp với kiến trúc hiện tại vì gateway cần:

- Spawn child process `omp`.
- Giao tiếp stdin/stdout.
- Supervise process lifecycle.
- Duy trì worker process lâu dài.

Gateway và `omp` nên chạy trên cùng host hoặc cùng container. Nếu gateway ở Docker còn `omp` ở host, container không thể trực tiếp spawn host process; phải thêm bridge/sidecar hoặc đổi sang network transport.

### 3.3 Lý do không dùng tRPC/oRPC

API công khai cần giữ contract OpenAI-compatible:

```text
GET  /v1/models
POST /v1/chat/completions
```

Streaming SSE, error format và request/response shape nên được implement trực tiếp bằng Hono. tRPC/oRPC không phải dependency bắt buộc của wire contract này.

### 3.4 Lý do không dùng auth framework

Open WebUI ban đầu chỉ cần Bearer API key. Chưa có yêu cầu user account, dashboard hay delegated login. Dùng Hono middleware cho API key là đủ; Better Auth/Clerk có thể thêm sau nếu scope thay đổi.

## 4. RPC contract bắt buộc

### 4.1 Handshake

Gateway phải:

1. Đọc frame `ready`.
2. Kiểm tra protocol versions.
3. Negotiate protocol v2.
4. Ghi nhận và validate:
   - `maxFrameBytes`.
   - `maxReassembledFrameBytes`.

### 4.2 Correlation

- Mọi command gateway gửi phải có `id`.
- Map pending request theo `id`.
- Phân biệt response đồng bộ với asynchronous event.

### 4.3 Commands cần dùng

```text
negotiate_protocol
get_state
prompt
steer
follow_up
abort
abort_and_prompt
switch_session
new_session
get_messages
get_messages_page
get_session_stats
```

### 4.4 Event cần forward

```text
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
```

Event chưa biết phải được xử lý forward-compatible, không làm crash gateway.

### 4.5 Process supervision

Gateway phải xử lý:

- EOF.
- Worker crash.
- Reject pending requests khi worker chết.
- Restart theo policy.
- Giữ external conversation mapping.
- Báo rõ session interruption.
- Graceful shutdown trước khi kill process.

## 5. Session persistence và resume

RPC mode có session state của `oh-my-pi`, không chỉ là một stream tạm thời.

Flow dự kiến:

```text
1. Spawn omp --mode rpc --session-dir <dir>
2. Nhận ready
3. Negotiate v2
4. Gọi get_state
5. Lấy sessionFile/sessionId
6. Lưu mapping external ID -> sessionFile
7. Gửi prompt
```

Khi worker restart:

```text
1. Spawn worker mới với cùng session directory
2. Negotiate v2
3. Gửi switch_session(sessionPath)
4. Gọi get_state để kiểm tra
5. Tiếp tục prompt
```

`sessionPath` chỉ hoạt động nếu gateway và worker nhìn thấy cùng filesystem. Với child process trên cùng host/container, điều kiện này được đáp ứng.

## 6. Kết quả smoke test đã xác nhận

Smoke test được chạy trên checkout `.research/oh-my-pi`, source version `17.2.10`, bằng Bun trên host Linux. Không chạy qua Docker và chưa có gateway Better T Stack thật.

### 6.1 Startup và negotiation

Lệnh thực tế:

```bash
bun packages/coding-agent/src/cli.ts \
  --mode rpc \
  --session-dir /tmp/omp-rpc-smoke-<temp>
```

Kết quả:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

Negotiate v2 trả về thành công:

```json
{
  "type": "response",
  "command": "negotiate_protocol",
  "success": true,
  "data": { "protocolVersion": 2 }
}
```

### 6.2 Session discovery

`get_state` trả về thành công và chứa:

```text
sessionFile
sessionId
messageCount
```

Điều này xác nhận RPC worker expose session file hiện tại cho gateway.

### 6.3 Restart và resume

Smoke test đã thực hiện:

1. Gọi `set_session_name` với tên `RPC smoke persistence`.
2. Dừng worker.
3. Spawn worker mới với cùng `--session-dir`.
4. Gọi `switch_session` với session file cũ.
5. Nhận response:

```json
{
  "command": "switch_session",
  "success": true,
  "data": { "cancelled": false }
}
```

6. Gọi `get_state` sau switch.
7. Xác nhận lại cùng `sessionFile`, cùng `sessionId` và tên session `RPC smoke persistence`.

Session JSONL vẫn tồn tại sau shutdown.

### 6.4 Phạm vi chưa được smoke test

Smoke test trên chưa gọi `prompt` thật tới LLM provider. Vì vậy các điểm sau chưa được xác nhận end-to-end:

- Provider authentication.
- LLM response streaming.
- `message_update` thực tế từ một prompt.
- Tool execution event.
- OpenAI-compatible SSE adapter.
- Discord streaming/chunking.

Đây là các test tiếp theo khi gateway được implement.

## 7. Contract smoke test chính thức cần có

Mỗi lần update binary `omp`, gateway nên chạy tối thiểu:

```text
spawn omp --mode rpc
receive ready
negotiate protocol v2
get_state
send prompt
receive message_update
receive turn_end/agent_end
send abort
terminate cleanly
```

Thêm test resume:

```text
set session metadata
stop worker
spawn worker mới
switch_session(sessionFile)
get_state
assert same sessionId/sessionFile/metadata
```

## 8. Quyết định triển khai hiện tại

Bắt đầu bằng:

```text
Better T Stack
  Bun
  Hono
  no frontend
  no database
  no ORM
  no tRPC/oRPC
  no auth framework

Gateway
  custom JSONL RPC transport
  SessionWorkerPool
  Discord adapter
  OpenAI-compatible Hono server
  filesystem-backed session mapping

Agent
  omp --mode rpc
  one child process per conversation
  oh-my-pi session files as source of truth
```

Chưa thêm database, Redis, queue, dashboard hoặc multi-instance orchestration.

## 9. Tài liệu tham khảo

- Better T Stack CLI: <https://github.com/amanvarshney01/create-better-t-stack/blob/main/apps/web/content/docs/cli/index.mdx>
- Better T Stack project configuration: <https://github.com/amanvarshney01/create-better-t-stack/blob/main/apps/web/content/docs/project-structure.mdx>
- Better T Stack compatibility: <https://github.com/amanvarshney01/create-better-t-stack/blob/main/apps/web/content/docs/cli/compatibility.mdx>
- Open WebUI agent connection: <https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/>
