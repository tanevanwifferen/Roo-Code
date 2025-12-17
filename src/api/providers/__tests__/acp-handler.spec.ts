// Mock ACP client
const mockSendPrompt = vi.fn()
const mockCancelSession = vi.fn()
const mockCreateSession = vi.fn()
const mockConnect = vi.fn()
const mockWaitReady = vi.fn()
const mockStop = vi.fn()
const mockIsReady = vi.fn()
const mockCreateTextContent = vi.fn()
const mockCreateImageContent = vi.fn()

vi.mock("../acp/acp-client", () => {
	return {
		AcpClient: vi.fn().mockImplementation(() => ({
			connect: mockConnect,
			waitReady: mockWaitReady,
			createSession: mockCreateSession,
			sendPrompt: mockSendPrompt,
			cancelSession: mockCancelSession,
			stop: mockStop,
			isReady: mockIsReady,
			createTextContent: mockCreateTextContent,
			createImageContent: mockCreateImageContent,
			handlers: {
				onSessionUpdate: vi.fn(),
			},
		})),
	}
})

import type { Anthropic } from "@anthropic-ai/sdk"
import { AcpHandler } from "../acp/acp-handler"
import type { ApiHandlerOptions } from "../../../shared/api"

describe("AcpHandler", () => {
	let handler: AcpHandler
	let mockOptions: ApiHandlerOptions

	beforeEach(() => {
		mockOptions = {
			apiModelId: "acp-agent",
			acpTransportType: "stdio",
			acpCommand: "test-agent",
			acpArgs: [],
		}
		handler = new AcpHandler(mockOptions)

		// Reset all mocks
		mockSendPrompt.mockClear()
		mockCancelSession.mockClear()
		mockCreateSession.mockClear()
		mockConnect.mockClear()
		mockWaitReady.mockClear()
		mockStop.mockClear()
		mockIsReady.mockClear()
		mockCreateTextContent.mockClear()
		mockCreateImageContent.mockClear()

		// Default mock implementations
		mockIsReady.mockReturnValue(false)
		mockConnect.mockResolvedValue(undefined)
		mockWaitReady.mockResolvedValue(undefined)
		mockCreateSession.mockResolvedValue("test-session-id")
		mockSendPrompt.mockResolvedValue(undefined)
		mockCreateTextContent.mockImplementation((text: string) => ({ type: "text", text }))
		mockCreateImageContent.mockImplementation((data: string, mediaType: string) => ({
			type: "image",
			data,
			mediaType,
		}))
	})

	describe("constructor", () => {
		it("should initialize with provided options", () => {
			expect(handler).toBeInstanceOf(AcpHandler)
		})
	})

	describe("createMessage - incremental message sending", () => {
		const systemPrompt = "You are a helpful assistant."
		const firstMessage: Anthropic.Messages.MessageParam = {
			role: "user",
			content: "Hello!",
		}
		const secondMessage: Anthropic.Messages.MessageParam = {
			role: "assistant",
			content: "Hi there!",
		}
		const thirdMessage: Anthropic.Messages.MessageParam = {
			role: "user",
			content: "How are you?",
		}

		it("should send system prompt and first message on initial call", async () => {
			const stream = handler.createMessage(systemPrompt, [firstMessage])

			// Consume the stream
			const chunks: any[] = []
			for await (const chunk of stream) {
				chunks.push(chunk)
			}

			// Verify session was created
			expect(mockConnect).toHaveBeenCalledTimes(1)
			expect(mockCreateSession).toHaveBeenCalledTimes(1)

			// Verify system prompt and first message were sent
			expect(mockCreateTextContent).toHaveBeenCalledWith(expect.stringContaining("<system>"))
			expect(mockCreateTextContent).toHaveBeenCalledWith(expect.stringContaining("Hello!"))
		})

		it("should send only new messages on subsequent calls", async () => {
			// First call with one message
			const stream1 = handler.createMessage(systemPrompt, [firstMessage])
			for await (const _chunk of stream1) {
				// Consume stream
			}

			mockCreateTextContent.mockClear()
			mockIsReady.mockReturnValue(true) // Client is now ready

			// Second call with two messages (one new)
			const stream2 = handler.createMessage(systemPrompt, [firstMessage, secondMessage])
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should only send the new message (secondMessage)
			// System prompt should not be sent again
			expect(mockCreateTextContent).not.toHaveBeenCalledWith(expect.stringContaining("<system>"))
			// Should send the assistant message
			const textContentCalls = mockCreateTextContent.mock.calls
			expect(textContentCalls.length).toBe(1)
			expect(textContentCalls[0][0]).toContain("Hi there!")
		})

		it("should send only the latest new messages", async () => {
			// First call
			const stream1 = handler.createMessage(systemPrompt, [firstMessage])
			for await (const _chunk of stream1) {
				// Consume stream
			}

			mockIsReady.mockReturnValue(true) // Client is now ready

			// Second call
			const stream2 = handler.createMessage(systemPrompt, [firstMessage, secondMessage])
			for await (const _chunk of stream2) {
				// Consume stream
			}

			mockCreateTextContent.mockClear()

			// Third call with three messages (one new)
			const stream3 = handler.createMessage(systemPrompt, [firstMessage, secondMessage, thirdMessage])
			for await (const _chunk of stream3) {
				// Consume stream
			}

			// Should send the third message
			const textContentCalls = mockCreateTextContent.mock.calls
			expect(textContentCalls.length).toBe(1)
			expect(textContentCalls[0][0]).toContain("How are you?")
		})
	})

	describe("createMessage - session renewal on chat reset", () => {
		const systemPrompt = "You are a helpful assistant."
		const messages: Anthropic.Messages.MessageParam[] = [
			{ role: "user", content: "First message" },
			{ role: "assistant", content: "First response" },
			{ role: "user", content: "Second message" },
		]

		it("should create new session when message count decreases (chat reset)", async () => {
			// First call with 3 messages
			const stream1 = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			expect(mockCreateSession).toHaveBeenCalledTimes(1)
			const firstSessionId = await mockCreateSession.mock.results[0].value

			mockCreateSession.mockClear()
			mockCancelSession.mockClear()

			// Second call with only 1 message (chat was reset)
			const newMessages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "New conversation" }]

			mockIsReady.mockReturnValue(true)
			mockCreateSession.mockResolvedValue("new-session-id")

			const stream2 = handler.createMessage(systemPrompt, newMessages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should cancel old session and create new one
			expect(mockCancelSession).toHaveBeenCalledWith(firstSessionId)
			expect(mockCreateSession).toHaveBeenCalledTimes(1)
		})

		it("should reset tracking variables on session renewal", async () => {
			// First call with multiple messages
			const stream1 = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			mockCreateTextContent.mockClear()
			mockIsReady.mockReturnValue(true)
			mockCreateSession.mockResolvedValue("new-session-id")

			// Second call with fewer messages (reset)
			const newMessages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Fresh start" }]
			const stream2 = handler.createMessage(systemPrompt, newMessages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// System prompt should be sent again since it's a new session
			expect(mockCreateTextContent).toHaveBeenCalledWith(expect.stringContaining("<system>"))
			expect(mockCreateTextContent).toHaveBeenCalledWith(expect.stringContaining("Fresh start"))
		})
	})

	describe("disconnect", () => {
		it("should stop client and reset tracking variables", async () => {
			const systemPrompt = "Test"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			// Create a session first
			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// Consume stream
			}

			// Now disconnect
			handler.disconnect()

			expect(mockStop).toHaveBeenCalledTimes(1)

			// After disconnect, next call should send system prompt again
			mockCreateTextContent.mockClear()
			mockIsReady.mockReturnValue(false)
			mockCreateSession.mockResolvedValue("new-session-after-disconnect")

			const stream2 = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// System prompt should be sent again
			expect(mockCreateTextContent).toHaveBeenCalledWith(expect.stringContaining("<system>"))
		})
	})

	describe("stop", () => {
		it("should cancel the current session", async () => {
			const systemPrompt = "Test"
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Hello" }]

			// Create a session first
			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// Consume stream
			}

			const sessionId = await mockCreateSession.mock.results[0].value

			// Now stop
			handler.stop()

			expect(mockCancelSession).toHaveBeenCalledWith(sessionId)
		})
	})

	describe("getModel", () => {
		it("should return model info", () => {
			const modelInfo = handler.getModel()
			expect(modelInfo.id).toBeDefined()
			expect(modelInfo.info).toBeDefined()
		})
	})

	describe("countTokens", () => {
		it("should count tokens in content", async () => {
			const content: Anthropic.Messages.ContentBlockParam[] = [{ type: "text", text: "Hello world" }]
			const count = await handler.countTokens(content)
			expect(count).toBeGreaterThan(0)
		})

		it("should return 0 for empty content", async () => {
			const count = await handler.countTokens([])
			expect(count).toBe(0)
		})
	})

	describe("createMessage - boomerang task (conversation structure change)", () => {
		const systemPrompt = "You are a helpful assistant."

		it("should detect conversation structure change when first user message changes", async () => {
			// Initial conversation
			const initialMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Original task" },
				{ role: "assistant", content: "Working on it" },
			]

			// First call - establish baseline
			const stream1 = handler.createMessage(systemPrompt, initialMessages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			expect(mockCreateSession).toHaveBeenCalledTimes(1)
			const firstSessionId = await mockCreateSession.mock.results[0].value

			// Important: Set client as ready so renewSession() can work properly
			mockIsReady.mockReturnValue(true)
			mockCreateSession.mockClear()
			mockCancelSession.mockClear()
			mockCreateSession.mockResolvedValue("new-session-id")

			// Boomerang scenario: Different first message (parent task resumed)
			const boomerangMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Different parent task" }, // Changed!
				{ role: "assistant", content: "Parent response" },
			]

			// Second call - should detect structure change
			const stream2 = handler.createMessage(systemPrompt, boomerangMessages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should cancel old session and create new one due to structure change
			expect(mockCancelSession).toHaveBeenCalledWith(firstSessionId)
			expect(mockCreateSession).toHaveBeenCalled()
		})

		it("should NOT reset when appending messages to same conversation", async () => {
			// Initial conversation
			const initialMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Original task" },
				{ role: "assistant", content: "Working on it" },
			]

			// First call
			const stream1 = handler.createMessage(systemPrompt, initialMessages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			const sessionCountBefore = mockCreateSession.mock.calls.length
			mockCancelSession.mockClear()
			mockIsReady.mockReturnValue(true) // Client is ready, no need to reconnect

			// Same conversation, just adding more messages
			const extendedMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Original task" }, // Same first message
				{ role: "assistant", content: "Working on it" },
				{ role: "user", content: "Continue please" }, // New message
			]

			// Second call - should NOT detect structure change
			const stream2 = handler.createMessage(systemPrompt, extendedMessages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should NOT cancel session or create new one
			expect(mockCancelSession).not.toHaveBeenCalled()
			// Session count should remain the same (no new session created)
			expect(mockCreateSession.mock.calls.length).toBe(sessionCountBefore)
		})

		it("should handle boomerang with similar message count", async () => {
			// Parent task with 3 messages
			const parentMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Parent task" },
				{ role: "assistant", content: "Starting" },
				{ role: "user", content: "Continue" },
			]

			// First call
			const stream1 = handler.createMessage(systemPrompt, parentMessages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			// Important: Set client as ready so renewSession() can work properly
			mockIsReady.mockReturnValue(true)
			mockCreateSession.mockClear()
			mockCancelSession.mockClear()
			mockCreateSession.mockResolvedValue("resumed-session-id")

			// After delegation completes, parent resumes with different history
			// but similar count (boomerang scenario)
			const resumedParentMessages: Anthropic.Messages.MessageParam[] = [
				{ role: "user", content: "Different parent task" }, // Changed!
				{ role: "assistant", content: "Different response" },
				{ role: "user", content: "Subtask result: completed" }, // Injected result
			]

			// Second call - should detect structure change despite similar count
			const stream2 = handler.createMessage(systemPrompt, resumedParentMessages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should create new session due to structure change
			expect(mockCancelSession).toHaveBeenCalled()
			expect(mockCreateSession).toHaveBeenCalled()
		})

		it("should handle array content in first message", async () => {
			// Initial conversation with array content
			const initialMessages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "Task with image" },
						{ type: "image", source: { type: "base64", data: "abc123", media_type: "image/png" } },
					],
				},
			]

			// First call
			const stream1 = handler.createMessage(systemPrompt, initialMessages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			// Important: Set client as ready so renewSession() can work properly
			mockIsReady.mockReturnValue(true)
			mockCreateSession.mockClear()
			mockCancelSession.mockClear()
			mockCreateSession.mockResolvedValue("new-session-id")

			// Different first message with array content
			const changedMessages: Anthropic.Messages.MessageParam[] = [
				{
					role: "user",
					content: [
						{ type: "text", text: "Different task" }, // Changed text
						{ type: "image", source: { type: "base64", data: "xyz789", media_type: "image/png" } },
					],
				},
			]

			// Second call - should detect structure change
			const stream2 = handler.createMessage(systemPrompt, changedMessages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should create new session
			expect(mockCancelSession).toHaveBeenCalled()
			expect(mockCreateSession).toHaveBeenCalled()
		})

		it("should reset hash tracking on disconnect", async () => {
			// Initial conversation
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "user", content: "Task" }]

			// First call
			const stream1 = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream1) {
				// Consume stream
			}

			// Disconnect
			handler.disconnect()

			mockCreateSession.mockClear()
			mockCancelSession.mockClear()
			mockIsReady.mockReturnValue(false)
			mockCreateSession.mockResolvedValue("after-disconnect-session")

			// After disconnect, same message should not trigger structure change
			const stream2 = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream2) {
				// Consume stream
			}

			// Should create new session due to disconnect, not structure change
			expect(mockCreateSession).toHaveBeenCalledTimes(1)
			// But should not cancel (no previous session after disconnect)
			expect(mockCancelSession).not.toHaveBeenCalled()
		})

		it("should handle empty message array gracefully", async () => {
			// Empty messages should not cause errors
			const stream = handler.createMessage(systemPrompt, [])
			for await (const _chunk of stream) {
				// Consume stream
			}

			// Should still create session
			expect(mockCreateSession).toHaveBeenCalledTimes(1)
		})

		it("should handle messages with no user role", async () => {
			// Edge case: only assistant messages (shouldn't happen but handle gracefully)
			const messages: Anthropic.Messages.MessageParam[] = [{ role: "assistant", content: "Assistant only" }]

			const stream = handler.createMessage(systemPrompt, messages)
			for await (const _chunk of stream) {
				// Consume stream
			}

			// Should not crash
			expect(mockCreateSession).toHaveBeenCalledTimes(1)
		})
	})
})
