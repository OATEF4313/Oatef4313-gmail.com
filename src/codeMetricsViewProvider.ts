import * as path from 'path';
import * as vscode from 'vscode';
import { LINE_COUNT_THRESHOLD } from './constants';
import { mixpanelService } from './mixpanel';
import { CodeParser } from './parser';
import { getNonce } from './utils';

export class CodeMetricsViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'codeMetrics.metricsView';
  private _view?: vscode.WebviewView;
  private _threshold: number;
  private _parser: CodeParser;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._parser = new CodeParser();
    this._threshold =
      vscode.workspace.getConfiguration().get('codeMetrics.lineCountThreshold') ||
      LINE_COUNT_THRESHOLD;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview, this._extensionUri);
    this.addWebviewListeners(webviewView);

    const document = vscode.window.activeTextEditor?.document;

    // Update the content when the view is first opened
    this.updateContent(document);

    // Set up the visibility change listener
    webviewView.onDidChangeVisibility(() => {
      this.updateContent(document);
    });
  }

  private addWebviewListeners(webviewView: vscode.WebviewView) {
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'goToLine':
          this.goToLine(message.line);
          return;
        case 'openSetLineCountThreshold':
          mixpanelService.trackEvent('Action', {
            type: 'setLineCountThreshold',
            label: 'Set line count threshold',
          });
          vscode.commands.executeCommand('codeMetrics.setLineCountThreshold');
          return;
        case 'sendAnalytics':
          const { eventName, eventProps } = message.value;
          mixpanelService.trackEvent(eventName, eventProps);
          return;
      }
    });
  }

  private goToLine(line: number) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      const position = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
      mixpanelService.trackEvent('Action', { type: 'goToLine', label: 'Go to line' });
    }
  }

  public updateContent(document?: vscode.TextDocument) {
    if (!this._view) {
      return;
    }

    if (!document) {
      // No active editor
      this._view.webview.postMessage({
        type: 'update',
        content: {
          fileName: null,
          totalLines: 0,
          functions: [],
          maxLinesThreshold:
            vscode.workspace.getConfiguration().get('codeMetrics.lineCountThreshold') || 50,
        },
      });
      return;
    }

    const functions = this._parser.parseDocument(document);
    mixpanelService.trackEvent('BackgroundAction', {
      type: 'updatingWebview',
      label: 'Updating webview content with new functions',
      functionsCount: `${functions.length}`,
      maxLinesThreshold: `${this._threshold}`,
      languageId: document.languageId,
    });

    this._view.webview.postMessage({
      type: 'update',
      functions,
      fileName: path.basename(document.fileName),
      totalLines: document.lineCount,
      maxLinesThreshold: this._threshold,
    });
  }

  public updateThreshold(newThreshold: number) {
    this._threshold = newThreshold;
  }

  private _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'styles.css'));
    const nonce = getNonce();

    return `
          <!DOCTYPE html>
          <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline '; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https:; font-src ${webview.cspSource};">
                <title>Live Code Metrics Live</title>
                <link rel="stylesheet" type="text/css" href="${styleUri}">
            </head>
            <body>
                <div class="file-info-container">
                    <span class="file-info"></span>
                    <div class="line-limit"></div>
                </div>
                <div id="metrics-container"></div>
                <div id="hidden-items-container"></div>
                <script nonce="${nonce}">
                  window.onerror = function(message, source, lineno, colno, error) {
                    console.error('An error occurred:', message, 'at', source, lineno, colno);
                    if (error && error.stack) {
                      console.error('Stack trace:', error.stack);
                    }
                    vscode.postMessage({
                      command: 'sendAnalytics',
                       value: { eventName: 'Error', eventProps: {type: 'webviewLoadError', label: 'Webview loading error', value: error.message} }
                    });
                  };
                </script>
                <script nonce="${nonce}" src="${scriptUri}"></script>
            </body>
          </html>
          `;
  }
}
