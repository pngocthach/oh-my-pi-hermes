import { describe, expect, test } from "bun:test";
import {
	MAX_RPC_FRAME_BYTES,
	MAX_RPC_REASSEMBLED_BYTES,
	parseReadyFrame,
	type RpcFrame,
	RpcFrameDecoder,
	RpcProtocolError,
} from "../src/rpc/protocol";

describe("RPC wire protocol", () => {
	test("accepts the exact OMP protocol v2 handshake", () => {
		expect(
			parseReadyFrame({
				type: "ready",
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: MAX_RPC_FRAME_BYTES,
				maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			}),
		).toMatchObject({ type: "ready", protocolVersion: 1 });
	});

	test("rejects an incompatible frame limit", () => {
		expect(() =>
			parseReadyFrame({
				type: "ready",
				protocolVersion: 1,
				supportedProtocolVersions: [1, 2],
				maxFrameBytes: 1,
				maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
			}),
		).toThrow(RpcProtocolError);
	});

	test("reassembles ordered protocol v2 chunk frames", () => {
		const payload = {
			type: "message_end",
			message: { role: "assistant", text: "x".repeat(MAX_RPC_FRAME_BYTES) },
		};
		const bytes = Buffer.from(JSON.stringify(payload));
		const chunkSize = 256 * 1024;
		const count = Math.ceil(bytes.byteLength / chunkSize);
		const decoder = new RpcFrameDecoder();
		let result: RpcFrame | undefined;
		for (let index = 0; index < count; index += 1) {
			result = decoder.push({
				type: "rpc_chunk",
				chunkId: "test-chunk",
				index,
				count,
				byteLength: bytes.byteLength,
				data: bytes
					.subarray(index * chunkSize, (index + 1) * chunkSize)
					.toString("base64"),
			});
		}
		expect(result).toEqual(payload);
	});
});
