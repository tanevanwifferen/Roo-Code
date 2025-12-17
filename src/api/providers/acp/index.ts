/**
 * ACP (Agent Communication Protocol) Provider
 *
 * This module exports the ACP handler and client for integration
 * with external ACP-compatible coding agents.
 */

export { AcpHandler } from "./acp-handler"
export { AcpClient, type AcpClientConfig, type AcpClientHandlers, type AcpTransportConfig } from "./acp-client"
