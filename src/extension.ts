// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.lm.registerLanguageModelChatProvider('provider', new SampleChatModelProvider());

	context.subscriptions.push(disposable);
}

export function deactivate() { }

export class SampleChatModelProvider implements vscode.LanguageModelChatProvider {
	onDidChangeLanguageModelChatInformation?: vscode.Event<void> | undefined;

	provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions, token: vscode.CancellationToken): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
		return [
			getChatModelInfo("sample-dog-model", "Dog Model"),
			getChatModelInfo("sample-cat-model", "Cat Model"),
		];
	}
	provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken): Thenable<void> {
		let convertMessages = (messages: readonly vscode.LanguageModelChatRequestMessage[]) => {
			return messages.map(msg => ({
				role: msg.role === vscode.LanguageModelChatMessageRole.User ? 'user' : 'assistant',
				content: msg.content
					.filter(part => part instanceof vscode.LanguageModelTextPart)
					.map(part => (part as vscode.LanguageModelTextPart).value)
					.join('')
			}));
		}


		if (model.id === "sample-dog-model") {
			progress.report(new vscode.LanguageModelTextPart("Woof! This is a dog model response."));
		} else if (model.id === "sample-cat-model") {
			progress.report(new vscode.LanguageModelTextPart("Meow! This is a cat model response."));
		} else {
			progress.report(new vscode.LanguageModelTextPart("Unknown model."));
		}

		// LanguageModelTextPart - Text content
		// LanguageModelToolCallPart - Tool/function calls
		// LanguageModelToolResultPart - Tool result content
		return Promise.resolve();
	}
	provideTokenCount(model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage, token: vscode.CancellationToken): Thenable<number> {
		return Promise.resolve(42);
	}
}

function getChatModelInfo(id: string, name: string): vscode.LanguageModelChatInformation {
	return {
		id,
		name,
		tooltip: "A sample chat model for demonstration purposes.",
		family: "sample-family",
		maxInputTokens: 120000,
		maxOutputTokens: 8192,
		version: "1.0.0",
		capabilities: {
			toolCalling: true,
			imageInput: true,
		}
	};
}
