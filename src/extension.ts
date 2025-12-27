// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {

	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('provider', new SampleChatModelProvider(context)));

	context.subscriptions.push(vscode.commands.registerCommand('provider.manage', async () => {
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Enter your API Key',
			password: true,
		});
		if (apiKey) {
			await context.secrets.store('provider.apiKey', apiKey);
		}
	}));
}

export function deactivate() { }

interface GeminiResponse {
	candidates: Array<{
		content: {
			parts: Array<{
				text?: string;
			}>;
		};
	}>;
}

export class SampleChatModelProvider implements vscode.LanguageModelChatProvider {
	constructor(private readonly context: vscode.ExtensionContext) { }

	onDidChangeLanguageModelChatInformation?: vscode.Event<void> | undefined;

	provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		return this.context.secrets.get('provider.apiKey').then(apiKey => {
			if (!apiKey) {
				return Promise.resolve([]);
			}

			return fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=50`, {
				signal: controller.signal
			}).then(async (response) => {
				if (!response.ok) {
					throw new Error(`HTTP error! status: ${response.status}`);
				}

				const data = await response.json() as {
					models: Array<{
						name: string;
						displayName?: string;
						description?: string;
						baseModelId: string;
						version: string;
						inputTokenLimit: number;
						outputTokenLimit: number;
					}>;
				};

				return data.models.map((model) => ({
					id: model.name.split('/')[1],
					name: model.displayName ?? model.baseModelId,
					tooltip: model.description ?? '',
					family: 'Gemini',
					maxInputTokens: model.inputTokenLimit,
					maxOutputTokens: model.outputTokenLimit,
					version: model.version,
					capabilities: {
						toolCalling: true,
						imageInput: true,
					}
				}));
			}).catch((error: any) => {
				if (!token.isCancellationRequested) {
					vscode.window.showErrorMessage(`Failed to fetch models: ${error.message ?? String(error)}`);
				}
				return [];
			});
		});
	}
	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		const apiKey = await this.context.secrets.get('provider.apiKey');
		if (!apiKey) {
			return;
		}

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const convertMessages = (messages: readonly vscode.LanguageModelChatRequestMessage[]) => {
			return messages.map(msg => ({
				role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'model',
				parts: msg.content
					.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
					.map(part => ({ text: part.value }))
			}));
		};

		const contents = convertMessages(messages);

		const body = {
			contents,
			tools: [
				...(options.modelOptions?.google ? [{ "googleSearch": {} }] : []),
				{ "urlContext": {} }
				
			]
		};

		try {
			const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent?key=${encodeURIComponent(apiKey)}`, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json'
				},
				body: JSON.stringify(body),
				signal: controller.signal
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
			}

			const responseJson = await response.json() as GeminiResponse;

			if (responseJson.candidates && responseJson.candidates.length > 0) {
				const candidate = responseJson.candidates[0];
				if (candidate.content && candidate.content.parts) {
					let responseText = '';
					for (const part of candidate.content.parts) {
						if (part.text) {
							responseText += part.text;
						}
					}
					progress.report(new vscode.LanguageModelTextPart(responseText));
					// LanguageModelTextPart - Text content
					// LanguageModelToolCallPart - Tool/function calls
					// LanguageModelToolResultPart - Tool result content
				}
			}
		} catch (error: any) {
			if (!token.isCancellationRequested) {
				vscode.window.showErrorMessage(`Failed to get response: ${error.message ?? String(error)}`);
			}
		}
	}
	provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Thenable<number> {
		return Promise.resolve(42);
	}
}