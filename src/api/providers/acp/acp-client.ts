/**
 * ACP (Agent Communication Protocol) Client
 *
 * This is a TypeScript implementation of the ACP client, ported from
 * avante.nvim's Lua implementation. ACP is a JSON-RPC 2.0 based protocol
 * for communicating with AI coding agents.
 */

import { ChildProcess, spawn } from "child_process"
import { EventEmitter } from "events"
import type {
	AcpConnectionState,
	AcpClientCapabilities,
	AcpAgentCapabilities,
	AcpAuthMethod,
	AcpError,
	AcpSessionUpdate,
	AcpContent,
	AcpPermissionOption,
	AcpToolCall,
	ACP_ERROR_CODES,
} from "@roo-code/types"

/**
 * ACP transport configuration
 */
export interface AcpTransportConfig {
	type: "stdio" | "websocket" | "tcp"
	// stdio options
	command?: string
	args?: string[]
	env?: Record<string, string>
	// websocket/tcp options
	host?: string
	port?: number
}

/**
 * ACP client configuration
 */
export interface AcpClientConfig {
	transport: AcpTransportConfig
	timeout?: number
	reconnect?: boolean
	maxReconnectAttempts?: number
	heartbeatInterval?: number
	authMethod?: string
	cwd?: string
}

/**
 * ACP event handlers
 */
export interface AcpClientHandlers {
	onSessionUpdate?: (update: AcpSessionUpdate) => void
	onRequestPermission?: (
		toolCall: AcpToolCall,
		options: AcpPermissionOption[],
		callback: (optionId: string | null) => void,
	) => void
	onReadFile?: (
		path: string,
		line: number | null,
		limit: number | null,
		callback: (content: string) => void,
		errorCallback: (message: string, code?: number) => void,
	) => void
	onWriteFile?: (path: string, content: string, callback: (error: string | null) => void) => void
	onError?: (error: AcpError) => void
	onStateChange?: (newState: AcpConnectionState, oldState: AcpConnectionState) => void
}

/**
 * JSON-RPC 2.0 message types
 */
interface JsonRpcRequest {
	jsonrpc: "2.0"
	id: number
	method: string
	params?: Record<string, unknown>
}

interface JsonRpcNotification {
	jsonrpc: "2.0"
	method: string
	params?: Record<string, unknown>
}

interface JsonRpcResponse {
	jsonrpc: "2.0"
	id: number
	result?: unknown
	error?: AcpError
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/**
 * Pending request callback
 */
type RequestCallback = (result: unknown | null, error: AcpError | null) => void

/**
 * ACP Client implementation
 */
export class AcpClient extends EventEmitter {
	private static readonly ERROR_CODES = {
		PARSE_ERROR: -32700,
		INVALID_REQUEST: -32600,
		METHOD_NOT_FOUND: -32601,
		INVALID_PARAMS: -32602,
		INTERNAL_ERROR: -32603,
		AUTH_REQUIRED: -32000,
		RESOURCE_NOT_FOUND: -32002,
		TIMEOUT_ERROR: -32003,
		PROTOCOL_ERROR: -32004,
	}

	private config: AcpClientConfig
	private handlers: AcpClientHandlers
	private state: AcpConnectionState = "disconnected"
	private idCounter = 0
	private protocolVersion = 1
	private callbacks = new Map<number, RequestCallback>()
	private pendingResponses = new Map<number, [unknown | null, AcpError | null]>()
	private process: ChildProcess | null = null
	private buffer = ""
	private reconnectCount = 0
	private heartbeatTimer: NodeJS.Timeout | null = null

	public agentCapabilities: AcpAgentCapabilities | null = null
	public authMethods: AcpAuthMethod[] = []

	public readonly capabilities: AcpClientCapabilities = {
		fs: {
			readTextFile: true,
			writeTextFile: true,
		},
	}

	constructor(config: AcpClientConfig, handlers: AcpClientHandlers = {}) {
		super()
		this.config = config
		this.handlers = handlers
	}

	/**
	 * Get current connection state
	 */
	getState(): AcpConnectionState {
		return this.state
	}

	/**
	 * Check if client is ready
	 */
	isReady(): boolean {
		return this.state === "ready"
	}

	/**
	 * Check if client is connected
	 */
	isConnected(): boolean {
		return this.state !== "disconnected" && this.state !== "error"
	}

	/**
	 * Connect to the ACP agent
	 */
	async connect(): Promise<void> {
		if (this.state !== "disconnected") {
			return
		}

		await this.startTransport()
		await this.initialize()
	}

	/**
	 * Stop the client
	 */
	stop(): void {
		this.stopHeartbeat()
		this.stopTransport()
		this.callbacks.clear()
		this.pendingResponses.clear()
		this.reconnectCount = 0
	}

	/**
	 * Create a new session
	 */
	async createSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
		const result = await this.sendRequest<{ sessionId: string }>("session/new", {
			cwd,
			mcpServers,
		})

		if (!result || !result.sessionId) {
			throw this.createError(AcpClient.ERROR_CODES.PROTOCOL_ERROR, "Failed to create session: missing sessionId")
		}

		return result.sessionId
	}

	/**
	 * Load an existing session
	 */
	async loadSession(sessionId: string, cwd: string, mcpServers: unknown[] = []): Promise<unknown> {
		if (!this.agentCapabilities?.loadSession) {
			throw this.createError(AcpClient.ERROR_CODES.PROTOCOL_ERROR, "Agent does not support loading sessions")
		}

		return this.sendRequest("session/load", {
			sessionId,
			cwd,
			mcpServers,
		})
	}

	/**
	 * Send a prompt to the session
	 */
	async sendPrompt(sessionId: string, prompt: AcpContent[]): Promise<unknown> {
		return this.sendRequest("session/prompt", {
			sessionId,
			prompt,
		})
	}

	/**
	 * Send a text prompt to the session
	 */
	async sendTextPrompt(sessionId: string, text: string): Promise<unknown> {
		const prompt: AcpContent[] = [this.createTextContent(text)]
		return this.sendPrompt(sessionId, prompt)
	}

	/**
	 * Cancel the current session operation
	 */
	cancelSession(sessionId: string): void {
		this.sendNotification("session/cancel", { sessionId })
	}

	/**
	 * Wait for client to be ready
	 */
	waitReady(timeout = 10000): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.isReady()) {
				resolve()
				return
			}

			const startTime = Date.now()

			const checkReady = () => {
				if (this.isReady()) {
					resolve()
				} else if (this.state === "error") {
					reject(this.createError(AcpClient.ERROR_CODES.PROTOCOL_ERROR, "Client entered error state"))
				} else if (Date.now() - startTime > timeout) {
					reject(
						this.createError(AcpClient.ERROR_CODES.TIMEOUT_ERROR, "Timeout waiting for client to be ready"),
					)
				} else {
					setTimeout(checkReady, 100)
				}
			}

			checkReady()
		})
	}

	// Content creation helpers
	createTextContent(text: string, annotations?: Record<string, unknown>): AcpContent {
		return { type: "text", text, annotations } as AcpContent
	}

	createImageContent(
		data: string,
		mimeType: string,
		uri?: string,
		annotations?: Record<string, unknown>,
	): AcpContent {
		return { type: "image", data, mimeType, uri, annotations } as AcpContent
	}

	createResourceLinkContent(
		uri: string,
		name: string,
		description?: string,
		mimeType?: string,
		size?: number,
		title?: string,
		annotations?: Record<string, unknown>,
	): AcpContent {
		return {
			type: "resource_link",
			uri,
			name,
			description,
			mimeType,
			size,
			title,
			annotations,
		} as AcpContent
	}

	// Private methods

	private setState(state: AcpConnectionState): void {
		const oldState = this.state
		this.state = state
		this.handlers.onStateChange?.(state, oldState)
		this.emit("stateChange", state, oldState)
	}

	private createError(code: number, message: string, data?: unknown): AcpError {
		return { code, message, data }
	}

	private nextId(): number {
		return ++this.idCounter
	}

	private async startTransport(): Promise<void> {
		const { transport } = this.config

		if (transport.type === "stdio") {
			await this.startStdioTransport()
		} else if (transport.type === "websocket") {
			throw new Error("WebSocket transport not implemented yet")
		} else if (transport.type === "tcp") {
			throw new Error("TCP transport not implemented yet")
		} else {
			throw new Error(`Unsupported transport type: ${transport.type}`)
		}
	}

	private async startStdioTransport(): Promise<void> {
		const { transport, cwd } = this.config

		if (!transport.command) {
			throw new Error("Command is required for stdio transport")
		}

		this.setState("connecting")

		const env: Record<string, string | undefined> = {
			...process.env,
			...(transport.env || {}),
		}

		this.process = spawn(transport.command, transport.args || [], {
			cwd: cwd || process.cwd(),
			env,
			stdio: ["pipe", "pipe", "pipe"],
		})

		this.process.on("error", (error) => {
			console.error("ACP process error:", error)
			this.setState("error")
			this.handlers.onError?.(this.createError(AcpClient.ERROR_CODES.INTERNAL_ERROR, error.message))
		})

		this.process.on("exit", (code, signal) => {
			console.log(`ACP agent exited with code ${code} and signal ${signal}`)
			this.setState("disconnected")

			// Handle auto-reconnect
			if (this.config.reconnect && this.reconnectCount < (this.config.maxReconnectAttempts || 3)) {
				this.reconnectCount++
				setTimeout(() => {
					if (this.state === "disconnected") {
						this.connect().catch(console.error)
					}
				}, 2000)
			}
		})

		if (this.process.stdout) {
			this.process.stdout.on("data", (data: Buffer) => {
				this.handleStdoutData(data)
			})
		}

		if (this.process.stderr) {
			this.process.stderr.on("data", (data: Buffer) => {
				// Log stderr for debugging but don't treat as errors
				console.debug("ACP stderr:", data.toString())
			})
		}

		this.setState("connected")
	}

	private handleStdoutData(data: Buffer): void {
		this.buffer += data.toString()

		// Split on newlines and process complete JSON-RPC messages
		const lines = this.buffer.split("\n")
		this.buffer = lines[lines.length - 1] // Keep incomplete line in buffer

		for (let i = 0; i < lines.length - 1; i++) {
			const line = lines[i].trim()
			if (line) {
				try {
					const message = JSON.parse(line) as JsonRpcMessage
					this.handleMessage(message)
				} catch (error) {
					console.warn("Failed to parse JSON-RPC message:", line)
				}
			}
		}
	}

	private stopTransport(): void {
		if (this.process) {
			try {
				this.process.kill("SIGTERM")
				setTimeout(() => {
					if (this.process) {
						this.process.kill("SIGKILL")
					}
				}, 1000)
			} catch {
				// Process may already be dead
			}
			this.process = null
		}
		this.setState("disconnected")
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer)
			this.heartbeatTimer = null
		}
	}

	private send(data: string): boolean {
		if (this.process?.stdin && !this.process.stdin.destroyed) {
			this.process.stdin.write(data + "\n")
			return true
		}
		return false
	}

	private async sendRequest<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T | null> {
		const id = this.nextId()
		const message: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			params: params || {},
		}

		const data = JSON.stringify(message)
		if (!this.send(data)) {
			return null
		}

		return this.waitResponse<T>(id)
	}

	private sendRequestWithCallback(
		method: string,
		params: Record<string, unknown> | undefined,
		callback: RequestCallback,
	): void {
		const id = this.nextId()
		const message: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			params: params || {},
		}

		this.callbacks.set(id, callback)
		this.send(JSON.stringify(message))
	}

	private sendNotification(method: string, params?: Record<string, unknown>): void {
		const message: JsonRpcNotification = {
			jsonrpc: "2.0",
			method,
			params: params || {},
		}
		this.send(JSON.stringify(message))
	}

	private sendResult(id: number, result: unknown): void {
		const message: JsonRpcResponse = {
			jsonrpc: "2.0",
			id,
			result: result ?? null,
		}
		this.send(JSON.stringify(message))
	}

	private sendError(id: number, message: string, code = AcpClient.ERROR_CODES.INTERNAL_ERROR): void {
		const response: JsonRpcResponse = {
			jsonrpc: "2.0",
			id,
			error: { code, message },
		}
		this.send(JSON.stringify(response))
	}

	private async waitResponse<T>(id: number): Promise<T | null> {
		const timeout = this.config.timeout || 100000
		const startTime = Date.now()

		while (Date.now() - startTime < timeout) {
			await new Promise((resolve) => setTimeout(resolve, 10))

			const pending = this.pendingResponses.get(id)
			if (pending) {
				const [result, error] = pending
				this.pendingResponses.delete(id)

				if (error) {
					throw error
				}

				return result as T
			}
		}

		throw this.createError(AcpClient.ERROR_CODES.TIMEOUT_ERROR, "Timeout waiting for response")
	}

	private handleMessage(message: JsonRpcMessage): void {
		// Check if this is a notification (has method but no result/error)
		if ("method" in message && !("result" in message) && !("error" in message)) {
			const id = "id" in message ? (message.id as number) : 0
			this.handleNotification(id, message.method, message.params || {})
		} else if ("id" in message && ("result" in message || "error" in message)) {
			// This is a response
			const response = message as JsonRpcResponse
			const callback = this.callbacks.get(response.id)

			if (callback) {
				callback(response.result ?? null, response.error ?? null)
				this.callbacks.delete(response.id)
			} else {
				this.pendingResponses.set(response.id, [response.result ?? null, response.error ?? null])
			}
		} else {
			console.warn("Unknown message type:", message)
		}
	}

	private handleNotification(messageId: number, method: string, params: Record<string, unknown>): void {
		switch (method) {
			case "session/update":
				this.handleSessionUpdate(params)
				break
			case "session/request_permission":
				this.handleRequestPermission(messageId, params)
				break
			case "fs/read_text_file":
				this.handleReadTextFile(messageId, params)
				break
			case "fs/write_text_file":
				this.handleWriteTextFile(messageId, params)
				break
			default:
				console.warn("Unknown notification method:", method)
		}
	}

	private handleSessionUpdate(params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string
		const update = params.update as AcpSessionUpdate

		if (!sessionId || !update) {
			console.warn("Received session/update without sessionId or update data")
			return
		}

		this.handlers.onSessionUpdate?.(update)
	}

	private handleRequestPermission(messageId: number, params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string
		const toolCall = params.toolCall as AcpToolCall
		const options = params.options as AcpPermissionOption[]

		if (!sessionId || !toolCall) {
			return
		}

		if (this.handlers.onRequestPermission) {
			this.handlers.onRequestPermission(toolCall, options, (optionId) => {
				this.sendResult(messageId, {
					outcome: {
						outcome: "selected",
						optionId,
					},
				})
			})
		}
	}

	private handleReadTextFile(messageId: number, params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string
		const path = params.path as string
		const line = params.line as number | undefined
		const limit = params.limit as number | undefined

		if (!sessionId || !path) {
			this.sendError(messageId, "Invalid fs/read_text_file params", AcpClient.ERROR_CODES.INVALID_PARAMS)
			return
		}

		if (this.handlers.onReadFile) {
			this.handlers.onReadFile(
				path,
				line ?? null,
				limit ?? null,
				(content) => {
					this.sendResult(messageId, { content })
				},
				(err, code) => {
					this.sendError(messageId, err || "Failed to read file", code)
				},
			)
		} else {
			this.sendError(
				messageId,
				"fs/read_text_file handler not configured",
				AcpClient.ERROR_CODES.METHOD_NOT_FOUND,
			)
		}
	}

	private handleWriteTextFile(messageId: number, params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string
		const path = params.path as string
		const content = params.content as string

		if (!sessionId || !path || content === undefined) {
			this.sendError(messageId, "Invalid fs/write_text_file params", AcpClient.ERROR_CODES.INVALID_PARAMS)
			return
		}

		if (this.handlers.onWriteFile) {
			this.handlers.onWriteFile(path, content, (error) => {
				this.sendResult(messageId, error === null ? null : error)
			})
		} else {
			this.sendError(
				messageId,
				"fs/write_text_file handler not configured",
				AcpClient.ERROR_CODES.METHOD_NOT_FOUND,
			)
		}
	}

	private async initialize(): Promise<void> {
		if (this.state !== "connected") {
			throw this.createError(AcpClient.ERROR_CODES.PROTOCOL_ERROR, "Cannot initialize: client not connected")
		}

		this.setState("initializing")

		const result = await this.sendRequest<{
			protocolVersion: number
			agentCapabilities: AcpAgentCapabilities
			authMethods?: AcpAuthMethod[]
		}>("initialize", {
			protocolVersion: this.protocolVersion,
			clientCapabilities: this.capabilities,
		})

		if (!result) {
			this.setState("error")
			throw this.createError(AcpClient.ERROR_CODES.PROTOCOL_ERROR, "Failed to initialize")
		}

		// Update protocol version and capabilities
		this.protocolVersion = result.protocolVersion
		this.agentCapabilities = result.agentCapabilities
		this.authMethods = result.authMethods || []

		// Check if we need to authenticate
		if (this.config.authMethod) {
			await this.authenticate(this.config.authMethod)
		}

		this.setState("ready")
	}

	private async authenticate(methodId: string): Promise<unknown> {
		return this.sendRequest("authenticate", { methodId })
	}
}
