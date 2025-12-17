/**
 * ACP (Agent Communication Protocol) Provider Types
 *
 * ACP is a protocol for communicating with AI coding agents. This allows
 * Roo-Code to connect to external ACP-compatible agents that handle
 * the code editing workflow autonomously.
 *
 * Implemented similar to how avante.nvim implements ACP support.
 */

import type { ModelInfo } from "../model.js"

/**
 * Transport types supported by ACP
 */
export const acpTransportTypes = ["stdio", "websocket", "tcp"] as const
export type AcpTransportType = (typeof acpTransportTypes)[number]

/**
 * ACP connection states
 */
export const acpConnectionStates = [
	"disconnected",
	"connecting",
	"connected",
	"initializing",
	"ready",
	"error",
] as const
export type AcpConnectionState = (typeof acpConnectionStates)[number]

/**
 * ACP tool call kinds
 */
export const acpToolKinds = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "other"] as const
export type AcpToolKind = (typeof acpToolKinds)[number]

/**
 * ACP tool call status
 */
export const acpToolCallStatuses = ["pending", "in_progress", "completed", "failed"] as const
export type AcpToolCallStatus = (typeof acpToolCallStatuses)[number]

/**
 * ACP stop reasons
 */
export const acpStopReasons = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"] as const
export type AcpStopReason = (typeof acpStopReasons)[number]

/**
 * ACP content types
 */
export interface AcpTextContent {
	type: "text"
	text: string
	annotations?: AcpAnnotations
}

export interface AcpImageContent {
	type: "image"
	data: string
	mimeType: string
	uri?: string
	annotations?: AcpAnnotations
}

export interface AcpAudioContent {
	type: "audio"
	data: string
	mimeType: string
	annotations?: AcpAnnotations
}

export interface AcpResourceLinkContent {
	type: "resource_link"
	uri: string
	name: string
	description?: string
	mimeType?: string
	size?: number
	title?: string
	annotations?: AcpAnnotations
}

export interface AcpResourceContent {
	type: "resource"
	resource: AcpEmbeddedResource
	annotations?: AcpAnnotations
}

export type AcpContent =
	| AcpTextContent
	| AcpImageContent
	| AcpAudioContent
	| AcpResourceLinkContent
	| AcpResourceContent

export interface AcpAnnotations {
	audience?: unknown[]
	lastModified?: string
	priority?: number
}

export interface AcpEmbeddedResource {
	uri: string
	text?: string
	blob?: string
	mimeType?: string
}

/**
 * ACP tool call content types
 */
export interface AcpToolCallRegularContent {
	type: "content"
	content: AcpContent
}

export interface AcpToolCallDiffContent {
	type: "diff"
	path: string
	oldText?: string
	newText: string
}

export type AcpToolCallContent = AcpToolCallRegularContent | AcpToolCallDiffContent

/**
 * ACP tool call location
 */
export interface AcpToolCallLocation {
	path: string
	line?: number
}

/**
 * ACP tool call
 */
export interface AcpToolCall {
	toolCallId: string
	title: string
	kind: AcpToolKind
	status: AcpToolCallStatus
	content: AcpToolCallContent[]
	locations: AcpToolCallLocation[]
	rawInput: Record<string, unknown>
	rawOutput: Record<string, unknown>
}

/**
 * ACP plan entry
 */
export interface AcpPlanEntry {
	content: string
	priority: "high" | "medium" | "low"
	status: "pending" | "in_progress" | "completed"
}

/**
 * ACP session updates
 */
export interface AcpUserMessageChunk {
	sessionUpdate: "user_message_chunk"
	content: AcpContent
}

export interface AcpAgentMessageChunk {
	sessionUpdate: "agent_message_chunk"
	content: AcpContent
}

export interface AcpAgentThoughtChunk {
	sessionUpdate: "agent_thought_chunk"
	content: AcpContent
}

export interface AcpToolCallUpdate {
	sessionUpdate: "tool_call" | "tool_call_update"
	toolCallId: string
	title?: string
	kind?: AcpToolKind
	status?: AcpToolCallStatus
	content?: AcpToolCallContent[]
	locations?: AcpToolCallLocation[]
	rawInput?: Record<string, unknown>
	rawOutput?: Record<string, unknown>
}

export interface AcpPlanUpdate {
	sessionUpdate: "plan"
	entries: AcpPlanEntry[]
}

export interface AcpAvailableCommandsUpdate {
	sessionUpdate: "available_commands_update"
	availableCommands: AcpAvailableCommand[]
}

export interface AcpAvailableCommand {
	name: string
	description: string
	input?: Record<string, unknown>
}

export type AcpSessionUpdate =
	| AcpUserMessageChunk
	| AcpAgentMessageChunk
	| AcpAgentThoughtChunk
	| AcpToolCallUpdate
	| AcpPlanUpdate
	| AcpAvailableCommandsUpdate

/**
 * ACP permission types
 */
export interface AcpPermissionOption {
	optionId: string
	name: string
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always"
}

export interface AcpRequestPermissionOutcome {
	outcome: "cancelled" | "selected"
	optionId?: string
}

/**
 * ACP client capabilities
 */
export interface AcpClientCapabilities {
	fs: {
		readTextFile: boolean
		writeTextFile: boolean
	}
}

/**
 * ACP agent capabilities
 */
export interface AcpAgentCapabilities {
	loadSession: boolean
	promptCapabilities: {
		image: boolean
		audio: boolean
		embeddedContext: boolean
	}
}

/**
 * ACP authentication method
 */
export interface AcpAuthMethod {
	id: string
	name: string
	description?: string
}

/**
 * ACP MCP server configuration
 */
export interface AcpMcpServer {
	name: string
	command: string
	args: string[]
	env: Array<{ name: string; value: string }>
}

/**
 * ACP error
 */
export interface AcpError {
	code: number
	message: string
	data?: unknown
}

/**
 * ACP error codes (JSON-RPC 2.0 + ACP specific)
 */
export const ACP_ERROR_CODES = {
	// JSON-RPC 2.0
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	// ACP
	AUTH_REQUIRED: -32000,
	RESOURCE_NOT_FOUND: -32002,
	TIMEOUT_ERROR: -32003,
	PROTOCOL_ERROR: -32004,
} as const

/**
 * Default ACP model ID (used as a placeholder since ACP agents have their own models)
 */
export const acpDefaultModelId = "acp-agent"

/**
 * ACP models definition
 * Since ACP is a protocol to connect to external agents, the model info
 * reflects generic capabilities. The actual model used is determined by
 * the connected ACP agent.
 */
export const acpModels = {
	"acp-agent": {
		maxTokens: 128000,
		contextWindow: 200000,
		supportsImages: true,
		supportsPromptCache: false,
		inputPrice: 0, // Pricing depends on the connected agent
		outputPrice: 0,
		description: "External ACP-compatible coding agent",
	},
} as const satisfies Record<string, ModelInfo>

export type AcpModelId = keyof typeof acpModels
