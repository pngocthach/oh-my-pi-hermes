# Research: Biến oh-my-pi thành Hermes-style Agent

Ngày khảo sát: 2026-08-06

## 1. Mục tiêu

Mục tiêu là dùng oh-my-pi làm agent core, sau đó thêm hai lớp tích hợp độc lập:

- Discord adapter.
- OpenAI-compatible HTTP/SSE adapter cho Open WebUI.

Không port nguyên Hermes Agent và không sửa code Open WebUI.

## 2. Các repository đã khảo sát

Các repository được clone vào `.research/`, không tracked trong worktree chính:

| Repository   | Đường dẫn                | HEAD khảo sát |
| ------------ | ------------------------ | ------------- |
| Hermes Agent | `.research/hermes-agent` | `6e9cae6`     |
| Open WebUI   | `.research/open-webui`   | `01f4282`     |
| oh-my-pi     | `.research/oh-my-pi`     | `3a8591a8a`   |

`.research/` được thêm vào `.git/info/exclude`.

## 3. Open WebUI

Open WebUI có thể kết nối agent thông qua OpenAI-compatible API. Không cần plugin riêng nếu agent cung cấp đúng HTTP contract.

Các endpoint tối thiểu:

```text
GET  /v1/models
POST /v1/chat/completions
```

Nên hỗ trợ thêm:

- Bearer API key.
- Streaming SSE.
- OpenAI-compatible request/response/error format.
- Model discovery.
- Conversation/session continuity.
- Tool-progress hoặc reasoning progress nếu muốn hiển thị tiến trình.

Open WebUI chỉ làm frontend/proxy; agent chịu trách nhiệm quyết định tool, thực thi tool và stream kết quả.

Nếu Open WebUI chạy trong Docker còn agent chạy trên host, dùng:

```text
http://host.docker.internal:<port>/v1
```

Trên Linux cần `--add-host=host.docker.internal:host-gateway`, host networking, hoặc Docker bridge IP.

Tài liệu đã đọc:

- [Open WebUI - Connect an Agent](https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/)
- [Open WebUI - Hermes Agent](https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/hermes-agent/)
- [Open WebUI repository](https://github.com/open-webui/open-webui)

## 4. Hermes Agent

Các điểm tích hợp chính:

```text
.research/hermes-agent/plugins/platforms/discord/adapter.py
.research/hermes-agent/plugins/platforms/discord/plugin.yaml
.research/hermes-agent/gateway/platforms/base.py
.research/hermes-agent/gateway/platforms/api_server.py
```

### Discord adapter

Hermes Discord adapter thực hiện các việc chính:

1. Nhận message từ Discord.
2. Chuẩn hóa guild/channel/thread/user thành context.
3. Chọn hoặc tạo session.
4. Gọi agent.
5. Stream chunk về Discord.
6. Chia message dài theo giới hạn Discord.
7. Hiển thị tool progress.
8. Xử lý thread, mention, quyền user và reconnect.

Không cần port toàn bộ các tính năng Hermes như voice, attachment hoặc slash command ngay từ đầu. Nên lấy lại các nguyên tắc session mapping, chunking và streaming.

### Hermes API server

Hermes đã có API server OpenAI-compatible trong:

```text
.research/hermes-agent/gateway/platforms/api_server.py
```

Các route chính gồm:

```text
GET  /health
GET  /v1/models
POST /v1/chat/completions
POST /v1/responses
GET  /v1/responses/{id}
POST /v1/runs
GET  /v1/runs/{id}/events
```

Đây là mẫu tham khảo cho HTTP/SSE adapter của oh-my-pi.

Repository: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)

## 5. oh-my-pi SDK

Các public API phù hợp cho adapter trực tiếp:

```ts
createAgentSession(...)
AgentSession.prompt(...)
AgentSession.subscribe(...)
AgentSession.abort(...)
AgentSession.dispose(...)
```

Các file liên quan:

```text
.research/oh-my-pi/packages/coding-agent/src/index.ts
.research/oh-my-pi/packages/coding-agent/src/sdk.ts
.research/oh-my-pi/packages/coding-agent/src/session/agent-session.ts
.research/oh-my-pi/packages/coding-agent/src/session/agent-session-types.ts
.research/oh-my-pi/packages/coding-agent/src/session/agent-session-events.ts
```

Các event phù hợp để chuyển thành Discord output hoặc SSE:

```text
agent_start
message_start
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
```

## 6. Lịch sử và độ ổn định SDK

oh-my-pi hiện ở package version `17.2.10`.

Tần suất thay đổi trong history:

```text
packages/coding-agent/src/sdk.ts                         171 commits / 30 ngày
packages/coding-agent/src/sdk.ts                         436 commits / 90 ngày
packages/coding-agent/src/sdk.ts                         580 commits / 180 ngày
packages/coding-agent/src/session/agent-session.ts       430 commits / 30 ngày
packages/coding-agent/src/modes/rpc/rpc-types.ts          32 commits / 180 ngày
```

Commit refactor lớn:

```text
7eeaba047 2026-07-23
refactor(coding-agent/session): restructured monolithic agent session

+3,475 / -14,632 lines trong agent-session.ts
```

Giữa `v17.0.0` và `v17.2.10`, các method public cốt lõi vẫn giữ shape chính:

```text
AgentSession.subscribe(listener)
AgentSession.prompt(text, options?)
AgentSession.abort(options?)
AgentSession.dispose(options?)
```

Tuy nhiên internals thay đổi rất nhanh. Một số export đã thay đổi hoặc được bổ sung:

- `zod` chuyển từ `zod/v4` sang `@oh-my-pi/omptype/zod`.
- Thêm `AgentRef`, `AgentRegistry`, `MAIN_AGENT_ID`.
- Thêm `customToolToDefinition`.
- Thêm API auto-learn capture.
- `CreateAgentSessionOptions` liên tục được mở rộng bằng optional fields.

Kết luận: SDK đủ dùng cho adapter embedded nếu pin version, nhưng không nên để Discord/Open WebUI gateway phụ thuộc trực tiếp vào internals của SDK.

## 7. Quyết định kiến trúc: RPC-first

Sau khi cân nhắc, lớp chính nên dùng RPC thay vì import SDK trực tiếp.

Lý do:

- Cập nhật binary `omp` mà không build lại gateway.
- Không dính chặt vào TypeScript API và internal refactor.
- Gateway có thể viết bằng TypeScript, Python, Go hoặc Rust.
- Agent chạy process riêng, dễ restart và cô lập crash.
- Discord và Open WebUI dùng chung một transport boundary.

Điều kiện quan trọng:

> Gateway không được import `rpc-client.ts` hoặc các type internal của oh-my-pi. Gateway phải phụ thuộc vào wire protocol độc lập.

Cập nhật `omp` không cần build lại gateway miễn là RPC protocol vẫn backward-compatible. Nếu protocol breaking hoặc semantics thay đổi, gateway vẫn phải update.

## 8. RPC contract hiện tại

Source:

```text
.research/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts
.research/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts
.research/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-frame.ts
.research/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-client.ts
```

RPC dùng JSON Lines:

```text
stdin:  command JSON objects
stdout: response and event JSON objects
```

Các command cần dùng cho gateway:

```text
negotiate_protocol
prompt
steer
follow_up
abort
abort_and_prompt
new_session
get_state
```

Response có dạng khái quát:

```json
{
  "type": "response",
  "command": "prompt",
  "id": "request-id",
  "success": true,
  "data": {}
}
```

Event stream gồm các event session/tool như:

```text
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
turn_end
agent_end
```

RPC hiện có protocol negotiation:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

Gateway nên negotiate protocol v2 và validate frame limits. Không nên giả định mọi message luôn vừa trong một dòng JSON nhỏ.

## 9. Session process model

Trong `rpc-mode.ts`, một process giữ một biến `session` và các command `prompt`, `steer`, `abort` thao tác trên session đó. `new_session` thay đổi session hiện tại.

Do đó, phiên bản đầu nên dùng một worker process cho mỗi conversation:

```text
Discord guild/channel/thread A -> omp RPC worker A
Discord guild/channel/thread B -> omp RPC worker B
OpenWebUI conversation X       -> omp RPC worker X
```

Gateway cần có `SessionWorkerPool`:

```text
external conversation ID -> child process + stdin/stdout reader
```

Không nên gửi nhiều conversation độc lập vào cùng một RPC process nếu chưa xây multiplexing layer riêng.

## 10. Kiến trúc đề xuất

```text
+----------------------+
| Discord adapter      |
+----------+-----------+
           |
+----------v-----------+
| Open WebUI adapter   |
+----------+-----------+
           |
+----------v-----------+
| SessionWorkerPool    |
| conversation -> child|
+----------+-----------+
           |
           | JSONL stdin/stdout
           v
     omp --mode rpc
```

Cấu trúc gateway dự kiến:

```text
gateway/
  session-worker.ts
  session-worker-pool.ts
  rpc-transport.ts
  discord-adapter.ts
  openai-server.ts
  message-format.ts
```

Session key đề xuất:

```text
discord:<guild>:<channel>:<thread-or-user>
openwebui:<conversation-id>
```

Cả hai adapter chỉ cần gọi abstraction chung:

```text
getOrCreateWorker(sessionKey)
sendPrompt(message)
subscribeEvents(listener)
abort()
stop()
```

## 11. Các yêu cầu bắt buộc cho RPC gateway

### Handshake

- Đọc `ready`.
- Kiểm tra protocol versions.
- Negotiate v2.
- Kiểm tra frame limits.

### Correlation

- Mọi command phải có `id`.
- Map pending request theo `id`.
- Không nhầm response với asynchronous event.

### Validation

- Validate JSON response/event trước khi xử lý.
- Xử lý unknown event theo kiểu forward-compatible.
- Không crash vì field mới trong response.

### Process supervision

- Detect EOF/crash.
- Reject các request đang pending.
- Restart worker theo policy.
- Giữ mapping conversation nhưng báo session interruption rõ ràng.
- Shutdown graceful trước khi kill process.

### Smoke contract test

Mỗi lần update `omp`, chạy tối thiểu:

```text
spawn omp --mode rpc
receive ready
negotiate protocol v2
send prompt
receive message_update
receive turn_end/agent_end
send abort
terminate cleanly
```

Nên có canary worker trước khi rollout toàn bộ binary mới.

## 12. Kết luận cuối

Kiến trúc được chọn:

- **Agent core:** oh-my-pi.
- **Runtime boundary:** `omp --mode rpc`.
- **Discord:** adapter riêng.
- **Open WebUI:** OpenAI-compatible HTTP/SSE server riêng.
- **Session:** process worker riêng cho mỗi conversation.
- **Open WebUI:** không fork, không sửa source.
- **SDK:** không phải dependency trực tiếp của gateway.

RPC là lựa chọn đúng nếu ưu tiên số một là cập nhật oh-my-pi thường xuyên mà không build lại lớp tích hợp. Rủi ro chính chuyển sang protocol compatibility, process lifecycle và session worker management; các rủi ro này cần được xử lý bằng negotiation, validation, supervision và contract smoke tests.
