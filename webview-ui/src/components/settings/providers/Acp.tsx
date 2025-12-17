import React, { useState, useEffect } from "react"
import { VSCodeTextField, VSCodeDropdown, VSCodeOption, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { type ProviderSettings, type AcpTransportType, acpTransportTypes } from "@roo-code/types"
import { useAppTranslation } from "@src/i18n/TranslationContext"

interface AcpProps {
	apiConfiguration: ProviderSettings
	setApiConfigurationField: (field: keyof ProviderSettings, value: ProviderSettings[keyof ProviderSettings]) => void
}

export const Acp: React.FC<AcpProps> = ({ apiConfiguration, setApiConfigurationField }) => {
	const { t } = useAppTranslation()

	const transportType = apiConfiguration?.acpTransportType || "stdio"

	// Local state for acpArgs display value to allow typing spaces
	const [acpArgsDisplay, setAcpArgsDisplay] = useState((apiConfiguration?.acpArgs || []).join(" "))
	const [acpArgsSpaceAtEnd, setAcpArgsSpaceAtEnd] = useState(false)

	// Sync display value when apiConfiguration changes externally
	useEffect(() => {
		setAcpArgsDisplay((apiConfiguration?.acpArgs || []).join(" "))
	}, [apiConfiguration?.acpArgs])

	const handleInputChange = (field: keyof ProviderSettings) => (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		setApiConfigurationField(field, element.value)
	}

	const handleNumberChange = (field: keyof ProviderSettings) => (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLInputElement
		const value = parseInt(element.value, 10)
		if (!isNaN(value)) {
			setApiConfigurationField(field, value)
		}
	}

	const handleCheckboxChange = (field: keyof ProviderSettings) => (e: Event | React.FormEvent<HTMLElement>) => {
		const target = e.target as HTMLInputElement
		setApiConfigurationField(field, target.checked)
	}

	const handleTransportChange = (e: Event | React.FormEvent<HTMLElement>) => {
		const element = e.target as HTMLSelectElement
		setApiConfigurationField("acpTransportType", element.value as AcpTransportType)
	}

	return (
		<div className="flex flex-col gap-4">
			{/* Transport Type */}
			<div>
				<label className="block font-medium mb-1">{t("settings:providers.acp.transportType")}</label>
				<VSCodeDropdown value={transportType} onChange={handleTransportChange} style={{ width: "100%" }}>
					<VSCodeOption value="stdio">{t("settings:providers.acp.transportStdio")}</VSCodeOption>
					<VSCodeOption value="websocket">{t("settings:providers.acp.transportWebsocket")}</VSCodeOption>
					<VSCodeOption value="tcp">{t("settings:providers.acp.transportTcp")}</VSCodeOption>
				</VSCodeDropdown>
				<p className="text-sm text-vscode-descriptionForeground mt-1">
					{t("settings:providers.acp.transportDescription")}
				</p>
			</div>

			{/* Stdio Transport Options */}
			{transportType === "stdio" && (
				<>
					<div>
						<VSCodeTextField
							value={apiConfiguration?.acpCommand || ""}
							style={{ width: "100%", marginTop: 3 }}
							type="text"
							onInput={handleInputChange("acpCommand")}
							placeholder={t("settings:providers.acp.commandPlaceholder")}>
							{t("settings:providers.acp.commandLabel")}
						</VSCodeTextField>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.acp.commandDescription")}
						</p>
					</div>

					<div>
						<VSCodeTextField
							value={acpArgsDisplay + (acpArgsSpaceAtEnd ? " " : "")}
							style={{ width: "100%", marginTop: 3 }}
							type="text"
							onInput={(e: Event | React.FormEvent<HTMLElement>) => {
								const element = e.target as HTMLInputElement
								const displayValue = element.value
								setAcpArgsDisplay(displayValue)
								setAcpArgsSpaceAtEnd(displayValue.endsWith(" "))
								// Split and filter only when updating the actual configuration
								const args = displayValue.split(" ").filter((arg) => arg !== "")
								setApiConfigurationField("acpArgs", args)
							}}
							placeholder={t("settings:providers.acp.argsPlaceholder")}>
							{t("settings:providers.acp.argsLabel")}
						</VSCodeTextField>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.acp.argsDescription")}
						</p>
					</div>
				</>
			)}

			{/* WebSocket/TCP Transport Options */}
			{(transportType === "websocket" || transportType === "tcp") && (
				<>
					<div>
						<VSCodeTextField
							value={apiConfiguration?.acpHost || ""}
							style={{ width: "100%", marginTop: 3 }}
							type="text"
							onInput={handleInputChange("acpHost")}
							placeholder={transportType === "websocket" ? "ws://localhost" : "localhost"}>
							{t("settings:providers.acp.hostLabel")}
						</VSCodeTextField>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.acp.hostDescription")}
						</p>
					</div>

					<div>
						<VSCodeTextField
							value={apiConfiguration?.acpPort?.toString() || ""}
							style={{ width: "100%", marginTop: 3 }}
							type="text"
							onInput={handleNumberChange("acpPort")}
							placeholder="8080">
							{t("settings:providers.acp.portLabel")}
						</VSCodeTextField>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.acp.portDescription")}
						</p>
					</div>
				</>
			)}

			{/* Connection Options */}
			<div className="border-t border-vscode-widget-border pt-4 mt-2">
				<h4 className="font-medium mb-3">{t("settings:providers.acp.connectionOptions")}</h4>

				<div className="flex flex-col gap-3">
					<div>
						<VSCodeTextField
							value={apiConfiguration?.acpTimeout?.toString() || "100000"}
							style={{ width: "100%", marginTop: 3 }}
							type="text"
							onInput={handleNumberChange("acpTimeout")}
							placeholder="100000">
							{t("settings:providers.acp.timeoutLabel")} (ms)
						</VSCodeTextField>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.acp.timeoutDescription")}
						</p>
					</div>

					<div>
						<VSCodeCheckbox
							checked={apiConfiguration?.acpReconnect ?? false}
							onChange={handleCheckboxChange("acpReconnect")}>
							{t("settings:providers.acp.reconnectLabel")}
						</VSCodeCheckbox>
						<p className="text-sm text-vscode-descriptionForeground mt-1 ml-6">
							{t("settings:providers.acp.reconnectDescription")}
						</p>
					</div>

					{apiConfiguration?.acpReconnect && (
						<div>
							<VSCodeTextField
								value={apiConfiguration?.acpMaxReconnectAttempts?.toString() || "3"}
								style={{ width: "100%", marginTop: 3 }}
								type="text"
								onInput={handleNumberChange("acpMaxReconnectAttempts")}
								placeholder="3">
								{t("settings:providers.acp.maxReconnectAttemptsLabel")}
							</VSCodeTextField>
							<p className="text-sm text-vscode-descriptionForeground mt-1">
								{t("settings:providers.acp.maxReconnectAttemptsDescription")}
							</p>
						</div>
					)}

					<div>
						<VSCodeTextField
							value={apiConfiguration?.acpAuthMethod || ""}
							style={{ width: "100%", marginTop: 3 }}
							type="text"
							onInput={handleInputChange("acpAuthMethod")}
							placeholder={t("settings:providers.acp.authMethodPlaceholder")}>
							{t("settings:providers.acp.authMethodLabel")}
						</VSCodeTextField>
						<p className="text-sm text-vscode-descriptionForeground mt-1">
							{t("settings:providers.acp.authMethodDescription")}
						</p>
					</div>
				</div>
			</div>

			{/* Information Box */}
			<div className="bg-vscode-textBlockQuote-background p-3 rounded-md mt-2">
				<p className="text-sm">{t("settings:providers.acp.info")}</p>
			</div>
		</div>
	)
}
