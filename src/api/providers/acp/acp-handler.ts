/**
 * ACP (Agent Communication Protocol) Handler
 *
 * This handler implements the ApiHandler interface for ACP agents,
 * allowing Roo-Code to connect to external ACP-compatible coding agents
 * that handle the code editing workflow autonomously.
 */

import type { Anthropic } from "@anthropic-ai/sdk"
import * as path from "path"
import * as fs from "fs"
import * as vscode from "vscode"
import {
	acpDefaultModelId,
	acpModels,
	type AcpModelId,
	type ModelInfo,
	type AcpSessionUpdate,
	type AcpContent,
	type AcpToolCall,
	type AcpPermissionOption,
} from "@roo-code/types"
import type { ApiHandler, ApiHandlerCreateMessageMetadata } from "../../index"
import type { ApiStream } from "../../transform/stream"
import { AcpClient, type AcpClientConfig, type AcpClientHandlers } from "./acp-client"
import type { ApiHandlerOptions } from "../../../shared/api"
import { countTokens } from "../../../utils/countTokens"

/**
 * ACP Handler implementation
 */
export class AcpHandler implements ApiHandler {
	private options: ApiHandlerOptions
	private client: AcpClient | null = null
	private sessionId: string | null = null
	private currentWorkspacePath: string
	private inputTokens: number = 0
	private outputTokens: number = 0

	constructor(options: ApiHandlerOptions) {
		this.options = options
		// Get the current workspace path
		this.currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd()
	}

	/**
	 * Create a message stream for the ACP agent
	 */
	async *createMessage(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
		metadata?: ApiHandlerCreateMessageMetadata,
	): ApiStream {
		// Reset token counters for this request
		this.inputTokens = 0
		this.outputTokens = 0

		// Ensure we have a connected client
		if (!this.client || !this.client.isReady()) {
			yield* this.connectAndCreateSession()
		}

		if (!this.client || !this.sessionId) {
			throw new Error("Failed to connect to ACP agent")
		}

		// Convert messages to ACP format
		const prompt = this.convertMessagesToAcpPrompt(systemPrompt, messages)

		// Estimate input tokens from the prompt
		this.inputTokens = await this.estimateTokens(systemPrompt, messages)

		// Create a queue for streaming updates
		const updateQueue: Array<{ type: "text" | "reasoning" | "usage" | "done"; data?: unknown }> = []
		let resolveNext: (() => void) | null = null
		let error: Error | null = null

		// Set up session update handler
		const originalHandler = this.client["handlers"].onSessionUpdate
		this.client["handlers"].onSessionUpdate = (update: AcpSessionUpdate) => {
			try {
				const result = this.processSessionUpdate(update)
				if (result) {
					updateQueue.push(result)
					resolveNext?.()
				}
			} catch (e) {
				error = e instanceof Error ? e : new Error(String(e))
				resolveNext?.()
			}
		}

		// Send the prompt
		try {
			this.client.sendPrompt(this.sessionId, prompt).then(
				() => {
					updateQueue.push({ type: "done" })
					resolveNext?.()
				},
				(e) => {
					error = e instanceof Error ? e : new Error(String(e))
					resolveNext?.()
				},
			)

			// Stream updates
			while (true) {
				if (error) {
					throw error
				}

				if (updateQueue.length > 0) {
					const update = updateQueue.shift()!
					if (update.type === "done") {
						break
					}

					if (update.type === "text") {
						const text = update.data as string
						// Count output tokens
						this.outputTokens += await countTokens([{ type: "text", text }], { useWorker: false })
						yield { type: "text", text }
					} else if (update.type === "reasoning") {
						const text = update.data as string
						// Count reasoning tokens as output
						this.outputTokens += await countTokens([{ type: "text", text }], { useWorker: false })
						yield { type: "reasoning", text }
					} else if (update.type === "usage") {
						yield update.data as { type: "usage"; inputTokens: number; outputTokens: number }
					}
				} else {
					// Wait for next update
					await new Promise<void>((resolve) => {
						resolveNext = resolve
						// Also resolve after a short timeout to check queue
						setTimeout(resolve, 100)
					})
				}
			}
		} finally {
			// Restore original handler
			if (originalHandler) {
				this.client["handlers"].onSessionUpdate = originalHandler
			}
		}

		// Yield final usage with estimated token counts
		// Note: ACP protocol doesn't provide usage info, so these are estimates
		// Cost is set to 0 since pricing depends on the connected agent
		yield {
			type: "usage",
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalCost: 0, // ACP agents handle their own billing
		}
	}

	/**
	 * Get the model information
	 */
	getModel(): { id: string; info: ModelInfo } {
		const modelId = this.options.apiModelId
		if (modelId && modelId in acpModels) {
			const id = modelId as AcpModelId
			return { id, info: acpModels[id] }
		}

		return {
			id: acpDefaultModelId,
			info: acpModels[acpDefaultModelId],
		}
	}

	/**
	 * Count tokens in content
	 */
	async countTokens(content: Anthropic.Messages.ContentBlockParam[]): Promise<number> {
		if (content.length === 0) {
			return 0
		}
		return countTokens(content, { useWorker: true })
	}

	/**
	 * Estimate input tokens from system prompt and messages
	 */
	private async estimateTokens(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): Promise<number> {
		let total = 0

		// Count system prompt tokens
		if (systemPrompt) {
			total += await countTokens([{ type: "text", text: systemPrompt }], { useWorker: false })
		}

		// Count message tokens
		for (const message of messages) {
			if (typeof message.content === "string") {
				total += await countTokens([{ type: "text", text: message.content }], { useWorker: false })
			} else if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (block.type === "text") {
						total += await countTokens([{ type: "text", text: block.text }], { useWorker: false })
					}
					// Note: Image tokens are harder to estimate accurately
					// Could add rough estimate based on image size if needed
				}
			}
		}

		return total
	}

	/**
	 * Stop the current session
	 */
	stop(): void {
		if (this.client && this.sessionId) {
			this.client.cancelSession(this.sessionId)
		}
	}

	/**
	 * Disconnect the client
	 */
	disconnect(): void {
		if (this.client) {
			this.client.stop()
			this.client = null
			this.sessionId = null
		}
	}

	// Private methods

	private async *connectAndCreateSession(): AsyncGenerator<never, void, unknown> {
		// Build client config from options
		const config = this.buildClientConfig()
		const handlers = this.buildClientHandlers()

		// Create and connect client
		this.client = new AcpClient(config, handlers)
		await this.client.connect()
		await this.client.waitReady()

		// Create session
		this.sessionId = await this.client.createSession(this.currentWorkspacePath)
	}

	private buildClientConfig(): AcpClientConfig {
		return {
			transport: {
				type: this.options.acpTransportType || "stdio",
				command: this.options.acpCommand,
				args: this.options.acpArgs,
				env: this.options.acpEnv,
				host: this.options.acpHost,
				port: this.options.acpPort,
			},
			timeout: this.options.acpTimeout || 100000,
			reconnect: this.options.acpReconnect ?? false,
			maxReconnectAttempts: this.options.acpMaxReconnectAttempts || 3,
			heartbeatInterval: this.options.acpHeartbeatInterval,
			authMethod: this.options.acpAuthMethod,
			cwd: this.currentWorkspacePath,
		}
	}

	private buildClientHandlers(): AcpClientHandlers {
		return {
			onSessionUpdate: (update) => {
				// Will be overridden during createMessage
				console.debug("ACP session update:", update)
			},
			onRequestPermission: async (toolCall, options, callback) => {
				// Show permission dialog to user
				const result = await this.showPermissionDialog(toolCall, options)
				callback(result)
			},
			onReadFile: async (filePath, line, limit, callback, errorCallback) => {
				try {
					const absolutePath = this.resolveFilePath(filePath)
					const content = await fs.promises.readFile(absolutePath, "utf-8")

					let lines = content.split("\n")
					if (line !== null && limit !== null) {
						lines = lines.slice(line - 1, line - 1 + limit)
					}

					callback(lines.join("\n"))
				} catch (err) {
					const error = err as NodeJS.ErrnoException
					if (error.code === "ENOENT") {
						errorCallback(`File not found: ${filePath}`, -32002) // RESOURCE_NOT_FOUND
					} else {
						errorCallback(error.message)
					}
				}
			},
			onWriteFile: async (filePath, content, callback) => {
				try {
					const absolutePath = this.resolveFilePath(filePath)

					// Ensure directory exists
					const dir = path.dirname(absolutePath)
					await fs.promises.mkdir(dir, { recursive: true })

					await fs.promises.writeFile(absolutePath, content, "utf-8")
					callback(null)
				} catch (err) {
					const error = err as Error
					callback(error.message)
				}
			},
			onError: (error) => {
				console.error("ACP client error:", error)
			},
			onStateChange: (newState, oldState) => {
				console.debug(`ACP state changed: ${oldState} -> ${newState}`)
			},
		}
	}

	private resolveFilePath(filePath: string): string {
		if (path.isAbsolute(filePath)) {
			return filePath
		}
		return path.join(this.currentWorkspacePath, filePath)
	}

	private async showPermissionDialog(toolCall: AcpToolCall, options: AcpPermissionOption[]): Promise<string | null> {
		// Find allow and reject options
		const allowOnce = options.find((o) => o.kind === "allow_once")
		const allowAlways = options.find((o) => o.kind === "allow_always")
		const rejectOnce = options.find((o) => o.kind === "reject_once")

		const items: vscode.QuickPickItem[] = []

		if (allowOnce) {
			items.push({ label: "$(check) Allow", description: "Allow this action once" })
		}
		if (allowAlways) {
			items.push({ label: "$(check-all) Allow Always", description: "Always allow this type of action" })
		}
		if (rejectOnce) {
			items.push({ label: "$(close) Deny", description: "Deny this action" })
		}

		const title = `ACP Agent: ${toolCall.title}`
		const result = await vscode.window.showQuickPick(items, {
			title,
			placeHolder: `The agent wants to perform: ${toolCall.kind}`,
		})

		if (!result) {
			return rejectOnce?.optionId ?? null
		}

		if (result.label.includes("Allow Always") && allowAlways) {
			return allowAlways.optionId
		}
		if (result.label.includes("Allow") && allowOnce) {
			return allowOnce.optionId
		}
		if (result.label.includes("Deny") && rejectOnce) {
			return rejectOnce.optionId
		}

		return null
	}

	private convertMessagesToAcpPrompt(
		systemPrompt: string,
		messages: Anthropic.Messages.MessageParam[],
	): AcpContent[] {
		const prompt: AcpContent[] = []

		// Add system prompt as context
		if (systemPrompt) {
			prompt.push(this.client!.createTextContent(`<system>\n${systemPrompt}\n</system>`))
		}

		// Convert each message
		for (const message of messages) {
			const role = message.role
			const content = message.content

			if (typeof content === "string") {
				prompt.push(this.client!.createTextContent(`<${role}>\n${content}\n</${role}>`))
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text") {
						prompt.push(this.client!.createTextContent(`<${role}>\n${block.text}\n</${role}>`))
					} else if (block.type === "image" && "source" in block) {
						// Handle image content if supported
						const source = block.source as { type: string; data: string; media_type: string }
						if (source.type === "base64") {
							prompt.push(this.client!.createImageContent(source.data, source.media_type))
						}
					}
				}
			}
		}

		return prompt
	}

	private processSessionUpdate(
		update: AcpSessionUpdate,
	): { type: "text" | "reasoning" | "usage" | "done"; data?: unknown } | null {
		switch (update.sessionUpdate) {
			case "agent_message_chunk":
				if (update.content.type === "text") {
					return { type: "text", data: update.content.text }
				}
				break

			case "agent_thought_chunk":
				if (update.content.type === "text") {
					return { type: "reasoning", data: update.content.text }
				}
				break

			case "tool_call":
			case "tool_call_update":
				// Emit tool call information as text
				const toolUpdate = update as AcpSessionUpdate & {
					sessionUpdate: "tool_call" | "tool_call_update"
					title?: string
					kind?: string
					status?: string
				}
				if (toolUpdate.title && toolUpdate.status === "in_progress") {
					return { type: "text", data: `\n[Tool: ${toolUpdate.title}]\n` }
				}
				break

			case "plan":
				// Could emit plan updates if needed
				break

			case "available_commands_update":
				// Handle command updates
				break
		}

		return null
	}
}
