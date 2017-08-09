"use strict";

import * as _ from "lodash";
import * as minimatch from "minimatch";
import Uri from "vscode-uri";
import * as path from "path";

import {
  IPCMessageReader, IPCMessageWriter,
  createConnection, IConnection, TextDocumentSyncKind,
  TextDocuments, InitializeParams, InitializeResult, TextDocumentPositionParams,
  RequestType, Location, Range, DocumentSymbolParams, WorkspaceSymbolParams,
  SymbolInformation, FileChangeType, ReferenceParams, CompletionItem
} from "vscode-languageserver";

import Workspace from "./intellisense/workspace/workspace";
import { WorkspaceFileParserFn } from "./intellisense/workspace/workspace-file";
import { findDefinition } from "./intellisense/definition-finder";
import { findReferences } from "./intellisense/reference-finder";
import { findCompletionItems } from "./intellisense/completion-provider";
import { getFileSymbols, getWorkspaceSymbols } from "./intellisense/symbol-provider";
import { Settings, Config } from "./utils/settings";
import { createFileSearchTrees } from "./intellisense/search-tree";
import { ConsoleLogger } from "./logger";

import * as asyncFs from "./utils/async-fs";

import { createRobotFile } from "./intellisense/workspace/robot-file";
import { createPythonFile } from "./intellisense/workspace/python-file";

const workspace = new Workspace();

function filePathFromUri(uri: string): string {
  return Uri.parse(uri).path;
}

// Create a connection for the server. The connection uses Node"s IPC as a transport
let connection: IConnection = createConnection(
  new IPCMessageReader(process), new IPCMessageWriter(process));

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

const logger = ConsoleLogger;

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites.
let workspaceRoot: string;
connection.onInitialize((params: InitializeParams): InitializeResult => {
  logger.info("Initializing...");

  const rootUri = params.rootUri;
  workspaceRoot = rootUri && Uri.parse(rootUri).fsPath;

  return {
    capabilities: {
      // Tell the client that the server works in FULL text document sync mode
      textDocumentSync: documents.syncKind,
      definitionProvider: true,
      documentSymbolProvider: true,
      workspaceSymbolProvider: true,
      referencesProvider: true,
      completionProvider: {
        triggerCharacters: [
          "[", "{", "*"
        ]
      }
    },
  };
});

// The settings have changed. Is send on server activation
// as well.
connection.onDidChangeConfiguration(change => {
  logger.info("onDidChangeConfiguration...");

  if (change.settings && change.settings.rfLanguageServer) {
    Config.setSettings(change.settings.rfLanguageServer);
  }
});

/**
 * Provides document symbols
 */
connection.onDocumentSymbol((documentSymbol: DocumentSymbolParams): SymbolInformation[] => {
  logger.info("onDocumentSymbol...");

  const filePath = filePathFromUri(documentSymbol.textDocument.uri);
  const fileTree = workspace.getFile(filePath);
  if (!fileTree) {
    return [];
  }

  return getFileSymbols(fileTree);
});

/**
 * Provides workspace symbols
 */
connection.onWorkspaceSymbol((workspaceSymbol: WorkspaceSymbolParams): SymbolInformation[] => {
  logger.info("onWorkspaceSymbol...");

  const query = workspaceSymbol.query;

  return getWorkspaceSymbols(workspace, query);
});

/**
 * Finds the definition for an item in the cursor position
 */
connection.onDefinition((textDocumentPosition: TextDocumentPositionParams): Location => {
  logger.info("onDefinition...");

  const filePath = filePathFromUri(textDocumentPosition.textDocument.uri);

  const found = findDefinition({
    filePath,
    position: {
      line: textDocumentPosition.position.line,
      column: textDocumentPosition.position.character,
    }
  }, workspace);

  if (!found) {
    return null;
  }

  return {
    uri: found.uri,
    range: found.range
  };
});

/**
 * Finds references for the symbol in document position
 */
connection.onReferences((referenceParams: ReferenceParams): Location[] => {
  logger.info("onReferences...");

  const filePath = filePathFromUri(referenceParams.textDocument.uri);

  const foundReferences = findReferences({
      filePath,
      position: {
        line:   referenceParams.position.line,
        column: referenceParams.position.character
      }
  }, workspace);

  return foundReferences;
});

/**
 * Provides completion items for given text position
 */
connection.onCompletion((textDocumentPosition: TextDocumentPositionParams): CompletionItem[] => {
  logger.info("onCompletion...");

  const filePath = filePathFromUri(textDocumentPosition.textDocument.uri);

  const completionItems = findCompletionItems({
    filePath,
    position: {
      line: textDocumentPosition.position.line,
      column: textDocumentPosition.position.character,
    }
  }, workspace);

  logger.debug(JSON.stringify(completionItems, null, 2));

  return completionItems;
});

export interface BuildFromFilesParam {
  files: string[];
}

export const BuildFromFilesRequest =
  new RequestType<BuildFromFilesParam, void, void, void>("buildFromFiles");

connection.onRequest(BuildFromFilesRequest, message => {
  logger.info("buildFromFiles", message);

  workspace.clear();

  message.files.forEach(readAndParseFile);
});

/**
 * Message sent when the content of a text document did change in VSCode.
 */
connection.onDidChangeTextDocument(params => {
  logger.info("onDidChangeTextDocument");

  // Because syncKind is set to Full, entire file content is received
  const filePath = filePathFromUri(params.textDocument.uri);
  const fileData = _.first(params.contentChanges).text;

  debouncedParseFile(filePath, fileData);
});

connection.onDidChangeWatchedFiles(params => {
  logger.info(`onDidChangeWatchedFiles ${ params.changes }`);

  // Remove deleted files
  params.changes
    .filter(change => change.type === FileChangeType.Deleted)
    .map(deletedFile => filePathFromUri(deletedFile.uri))
    .forEach(deletedFilePath => {
      logger.info("Removing file", deletedFilePath);
      workspace.removeFileByPath(deletedFilePath);
    });

  // Parse created files
  params.changes
    .filter(change => change.type === FileChangeType.Created)
    .map(createdFile => filePathFromUri(createdFile.uri))
    .filter(matchFilePathToConfig)
    .forEach(readAndParseFile);
});

function matchFilePathToConfig(filePath: string) {
  const { include, exclude } = Config.getIncludeExclude();

  const hasIncludePatterns = include.length > 0;
  const hasExcludePatterns = exclude.length > 0;

  const shouldInclude = !hasIncludePatterns ||
    _.some(include, pattern => minimatch(filePath, pattern));
  const shouldExclude = hasExcludePatterns &&
    _.some(exclude, pattern => minimatch(filePath, pattern));

  return shouldInclude && !shouldExclude;
}

const debouncedParseFile = (filePath: string, fileContents: string) => {
  try {
    const file = createWorkspaceFile(filePath, fileContents, createRobotFile);

    workspace.addFile(file);
  } catch (error) {
    logger.error("Failed to parse", filePath, error);
  }
};

async function readAndParseFile(filePath: string) {
  logger.info("Parsing", filePath);

  const createFn = path.extname(filePath) === ".py" ?
    createPythonFile : createRobotFile;

  try {
    const fileContents = await asyncFs.readFileAsync(filePath, "utf-8");
    const file = createWorkspaceFile(filePath, fileContents, createFn);

    workspace.addFile(file);
  } catch (error) {
    logger.error("Failed to parse", filePath, error);
  }
}

function createWorkspaceFile(filePath: string, fileContents: string, createFn: WorkspaceFileParserFn) {
  const relativePath = workspaceRoot ?
    path.relative(workspaceRoot, filePath) :
    filePath;

  return createFn(fileContents, filePath, relativePath);
}

// Listen on the connection
connection.listen();
