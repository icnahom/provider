import type { ContentListUnion, GenerateContentConfig, GoogleGenAI, Tool } from '@google/genai' with { "resolution-mode": "import" };
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';


export async function activate(context: vscode.ExtensionContext) {

	const provider = new LanguageModelChatProvider(context);

	context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('provider', provider));

	context.subscriptions.push(vscode.chat.createChatParticipant('provider.chat', chatRequestHandler));

	context.subscriptions.push(vscode.commands.registerCommand('provider.manage', async () => {
		const apiKey = await vscode.window.showInputBox({
			prompt: 'Provider API Key',
			password: true,
		});
		if (apiKey) {
			await context.secrets.store('provider.apiKey', apiKey);
		} else {
			await context.secrets.delete('provider.apiKey');
		}
		await provider.initialize();
	}));


}

export function deactivate() { }

export class LanguageModelChatProvider implements vscode.LanguageModelChatProvider {
	private _googleGenAi: GoogleGenAI | undefined;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.initialize();
	}

	async initialize() {
		const apiKey = await this.context.secrets.get('provider.apiKey');
		if (apiKey) {
			const module = await import('@google/genai');
			this._googleGenAi = new module.GoogleGenAI({ apiKey: apiKey });
		}
		else {
			this._googleGenAi = undefined;
		}

	}

	onDidChangeLanguageModelChatInformation?: vscode.Event<void> | undefined;

	async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested) {
			return [];
		}

		if (!this._googleGenAi) {
			await this.initialize();
			if (!this._googleGenAi) {
				if (!options.silent) {
					await vscode.commands.executeCommand('provider.manage');
				}
				if (!this._googleGenAi) {
					return [];
				}
			}
		}

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const models = await this._googleGenAi.models.list({ config: { abortSignal: controller.signal } });

		const _models: vscode.LanguageModelChatInformation[] = [];
		for await (const model of models) {
			if (token.isCancellationRequested) {
				return [];
			}
			_models.push({
				id: model.name ?? '',
				name: model.displayName ?? model.name ?? '',
				family: model.name ?? '',
				tooltip: model.description,
				detail: model.name,
				version: model.version ?? '',
				maxInputTokens: model.inputTokenLimit ?? 0,
				maxOutputTokens: model.outputTokenLimit ?? 0,
				capabilities: {
					toolCalling: true,
					imageInput: true,
				}
			});
		}
		return _models;
	}
	async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Promise<void> {
		if (token.isCancellationRequested) {
			return;
		}
		if (!this._googleGenAi) {
			await this.initialize();
			if (!this._googleGenAi) {
				return;
			}
		}

		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		const contents: ContentListUnion = messages.map(message => {
			return {
				role: message.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'model',
				parts: message.content.map(part => {
					if (part instanceof vscode.LanguageModelTextPart) {
						return { text: part.value };
					} else if (part instanceof vscode.LanguageModelToolCallPart) {
						let callIdAsMetadata: { id?: string; name: string; thoughtSignature?: string } = JSON.parse(part.callId);
						return {
							functionCall: {
								id: callIdAsMetadata.id,
								name: part.name,
								args: part.input as Record<string, unknown> || {}
							},
							thoughtSignature: callIdAsMetadata.thoughtSignature
						};
					} else if (part instanceof vscode.LanguageModelToolResultPart) {
						let callIdAsMetadata: { id?: string; name: string; thoughtSignature?: string } = JSON.parse(part.callId);
						const result = (part.content.find(p => p instanceof vscode.LanguageModelTextPart))?.value;
						return {
							functionResponse: {
								id: callIdAsMetadata.id,
								name: callIdAsMetadata.name,
								response: {
									result: result
								}
							}
						};
					} else if (part instanceof vscode.LanguageModelDataPart) {
						if (part.mimeType === 'thinking') {
							return { text: new TextDecoder().decode(part.data), thought: true };
						}
					}

					return null;

				}).filter(part => part !== null)
			};
		});

		const tools: Tool[] = options.modelOptions?.google
			? [{ googleSearch: {}, urlContext: {} }]
			: [{
				functionDeclarations: options.tools?.map(tool => {
					return {
						name: tool.name,
						description: tool.description,
						parametersJsonSchema: tool.inputSchema ?? {
							type: "object",
							properties: {},
							required: []
						}
					};
				}),
			}];

		const config: GenerateContentConfig = {
			abortSignal: controller.signal,
			tools: tools,
			thinkingConfig: {
				includeThoughts: false,
			}
		};

		const result = await this._googleGenAi.models.generateContentStream({
			model: model.id,
			contents: contents,
			config: config,
		});

		for await (const chunk of result) {
			if (token.isCancellationRequested) {
				break;
			}

			if (chunk.candidates && chunk.candidates.length > 0) {
				const candidate = chunk.candidates[0];

				if (candidate.content && candidate.content.parts) {
					for (const part of candidate.content.parts) {
						if (part.thought && part.text) {
							progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(part.text), 'thinking'));
						}
						else if (part.text) {
							progress.report(new vscode.LanguageModelTextPart(part.text!));
						}
						else if (part.functionCall) {
							const callIdAsMetadata = JSON.stringify({
								id: part.functionCall.id,
								name: part.functionCall.name!,
								thoughtSignature: part.thoughtSignature
							});
							progress.report(new vscode.LanguageModelToolCallPart(callIdAsMetadata, part.functionCall.name!, part.functionCall.args!));
						}
						else if (part.functionResponse) {
							const callIdAsMetadata = JSON.stringify({
								id: part.functionResponse.id,
								name: part.functionResponse.name!,
							});
							progress.report(new vscode.LanguageModelToolResultPart(callIdAsMetadata, [vscode.LanguageModelDataPart.json(part.functionResponse.response!)]));
						}
					}
				}
			}
		}
	}

	async provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Promise<number> {
		if (!this._googleGenAi) {
			await this.initialize();
			if (!this._googleGenAi) {
				return 0;
			}
		}


		const controller = new AbortController();
		token.onCancellationRequested(() => controller.abort());

		let contents: ContentListUnion;

		if (typeof text === 'string') {
			contents = [{ role: 'user', parts: [{ text }] }];
		} else {
			contents = [{
				role: text.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'model',
				parts: text.content.map(part => {
					if (part instanceof vscode.LanguageModelTextPart) {
						return { text: part.value };
					}
					return null;
				}).filter(part => part !== null)
			}];
		}

		const result = await this._googleGenAi.models.countTokens({ model: model.id, contents, config: { abortSignal: controller.signal } });
		return result.totalTokens ?? 0;
	}
}

const chatRequestHandler: vscode.ChatRequestHandler = async (request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<void> => {
	const response = await request.model.sendRequest(
		[
			...context.history.flatMap(history => {
				if (history instanceof vscode.ChatRequestTurn) {
					return vscode.LanguageModelChatMessage.User(history.prompt);
				};
				if (history instanceof vscode.ChatResponseTurn) {
					return history.response.filter(part => part instanceof vscode.ChatResponseMarkdownPart)
						.map(part => vscode.LanguageModelChatMessage.Assistant(part.value.value));
				};
				return null;
			}).filter(message => message !== null),
			vscode.LanguageModelChatMessage.User(request.prompt),
		],
		{
			tools: [],
			modelOptions: { google: request.command === 'google' ? true : false },
		},
		token,
	);

	for await (const part of response.stream) {
		if (part instanceof vscode.LanguageModelTextPart) {
			stream.markdown(part.value);
		}
	}

};