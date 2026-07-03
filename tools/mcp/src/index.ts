#!/usr/bin/env node

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

const DEFAULT_CMAJ_BIN = "F:/Programming/DSP_Projects/2025/cmajor-feather/build/tools/command/Release/cmaj.exe";
const DEFAULT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 300_000;

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type ToolArgs = Record<string, unknown>;

interface Diagnostic {
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "note" | "info";
  message: string;
}

interface CommandResult {
  command: string;
  args: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  durationMs: number;
}

interface EndpointInfo {
  id: string;
  direction: "input" | "output";
  type: "stream" | "event" | "value" | "unknown";
  dataType: string | null;
  channels: number | null;
  annotations: JsonObject;
  file: string;
  line: number;
}

const tools: Tool[] = [
  {
    name: "compile_check",
    description: "Compile-check a .cmajorpatch or .cmajor file and return structured diagnostics parsed from cmaj output.",
    inputSchema: {
      type: "object",
      properties: {
        patchPath: { type: "string", description: "Path to a .cmajorpatch or .cmajor file." }
      },
      required: ["patchPath"],
      additionalProperties: false
    }
  },
  {
    name: "patch_info",
    description: "Read a patch manifest and source declarations, returning endpoints, parameters, and a manifest summary.",
    inputSchema: {
      type: "object",
      properties: {
        patchPath: { type: "string", description: "Path to a .cmajorpatch or .cmajor file." }
      },
      required: ["patchPath"],
      additionalProperties: false
    }
  },
  {
    name: "render_wav",
    description: "Offline-render a .cmajorpatch to a WAV file using cmaj render.",
    inputSchema: {
      type: "object",
      properties: {
        patchPath: { type: "string" },
        outputWav: { type: "string" },
        lengthFrames: { type: "number" },
        rate: { type: "number" },
        inputWav: { type: "string" },
        midiFile: { type: "string" }
      },
      required: ["patchPath", "outputWav", "lengthFrames", "rate"],
      additionalProperties: false
    }
  },
  {
    name: "run_tests",
    description: "Run one .cmajtest file or a directory of .cmajtest files using cmaj test.",
    inputSchema: {
      type: "object",
      properties: {
        testFileOrDir: { type: "string", description: "Path to a .cmajtest file or directory." }
      },
      required: ["testFileOrDir"],
      additionalProperties: false
    }
  },
  {
    name: "create_patch",
    description: "Create a new Cmajor patch scaffold using cmaj create.",
    inputSchema: {
      type: "object",
      properties: {
        folder: { type: "string", description: "Destination folder to create." },
        name: { type: "string", description: "Patch name passed to --name." },
        ui: { type: "boolean", description: "Accepted for forward compatibility; the current cmaj create command has no UI flag." }
      },
      required: ["folder", "name"],
      additionalProperties: false
    }
  }
];

const server = new Server(
  { name: "cmajor-feather-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
  const args = asObject(request.params.arguments);

  try {
    switch (request.params.name) {
      case "compile_check":
        return await compileCheck(args);
      case "patch_info":
        return await patchInfo(args);
      case "render_wav":
        return await renderWav(args);
      case "run_tests":
        return await runTests(args);
      case "create_patch":
        return await createPatch(args);
      default:
        return jsonResult({ error: `Unknown tool: ${request.params.name}` }, true);
    }
  } catch (error) {
    return jsonResult({ error: errorMessage(error) }, true);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

void main().catch((error) => {
  process.stderr.write(`${errorMessage(error)}\n`);
  process.exitCode = 1;
});

async function compileCheck(args: ToolArgs): Promise<CallToolResult> {
  const patchPath = requireExistingPath(requireString(args, "patchPath"), "patchPath");
  const ext = path.extname(patchPath).toLowerCase();
  const commandArgs = ext === ".cmajorpatch"
    ? ["play", "--dry-run", "--stop-on-error", patchPath]
    : ext === ".cmajor"
      ? ["generate", "--target=syntaxtree", patchPath]
      : fail(`compile_check expects a .cmajorpatch or .cmajor file, got: ${patchPath}`);

  const result = await runCmaj(commandArgs, DEFAULT_TIMEOUT_MS);
  const output = combinedOutput(result);
  const diagnostics = parseDiagnostics(output);
  const hasErrorDiagnostic = diagnostics.some((diagnostic) => diagnostic.severity === "error");
  const ok = result.exitCode === 0 && !result.timedOut && !hasErrorDiagnostic;

  return jsonResult({
    ok,
    patchPath,
    diagnostics,
    command: summarizeCommand(result),
    stdout: result.stdout,
    stderr: result.stderr
  }, !ok);
}

async function patchInfo(args: ToolArgs): Promise<CallToolResult> {
  const patchPath = requireExistingPath(requireString(args, "patchPath"), "patchPath");
  const ext = path.extname(patchPath).toLowerCase();

  const manifest = ext === ".cmajorpatch" ? readManifest(patchPath) : null;
  const sourceFiles = manifest === null
    ? [patchPath]
    : resolveSourceFiles(patchPath, manifest);

  const endpoints = sourceFiles.flatMap((file) => parseEndpointsFromSource(file));
  const parameters = endpoints
    .filter((endpoint) => endpoint.direction === "input"
      && endpoint.type !== "stream"
      && typeof endpoint.annotations.name === "string")
    .map((endpoint) => ({
      id: endpoint.id,
      type: endpoint.type,
      dataType: endpoint.dataType,
      name: endpoint.annotations.name,
      min: endpoint.annotations.min ?? null,
      max: endpoint.annotations.max ?? null,
      init: endpoint.annotations.init ?? null,
      step: endpoint.annotations.step ?? null,
      unit: endpoint.annotations.unit ?? null,
      boolean: endpoint.annotations.boolean === true,
      group: endpoint.annotations.group ?? null,
      text: endpoint.annotations.text ?? null,
      annotations: endpoint.annotations
    }));

  return jsonResult({
    patchPath,
    manifest: manifest === null ? null : manifestSummary(manifest),
    sourceFiles,
    endpoints,
    parameters,
    notes: [
      "patch_info is a static manifest/source inspection. Use compile_check to validate compiler-resolved endpoint shape."
    ]
  }, false);
}

async function renderWav(args: ToolArgs): Promise<CallToolResult> {
  const patchPath = requireExistingPath(requireString(args, "patchPath"), "patchPath");
  const outputWav = path.resolve(requireString(args, "outputWav"));
  const lengthFrames = requirePositiveInteger(args, "lengthFrames");
  const rate = requirePositiveInteger(args, "rate");
  const commandArgs = [
    "render",
    `--output=${outputWav}`,
    `--length=${lengthFrames}`,
    `--rate=${rate}`
  ];

  if (args.inputWav !== undefined)
    commandArgs.push(`--input=${requireExistingPath(requireString(args, "inputWav"), "inputWav")}`);

  if (args.midiFile !== undefined)
    commandArgs.push(`--midi=${requireExistingPath(requireString(args, "midiFile"), "midiFile")}`);

  commandArgs.push(patchPath);
  fs.mkdirSync(path.dirname(outputWav), { recursive: true });

  const result = await runCmaj(commandArgs, RENDER_TIMEOUT_MS);
  const diagnostics = parseDiagnostics(combinedOutput(result));
  const ok = result.exitCode === 0
    && !result.timedOut
    && diagnostics.every((diagnostic) => diagnostic.severity !== "error")
    && fs.existsSync(outputWav);

  return jsonResult({
    ok,
    patchPath,
    outputWav,
    lengthFrames,
    rate,
    diagnostics,
    command: summarizeCommand(result),
    stdout: result.stdout,
    stderr: result.stderr
  }, !ok);
}

async function runTests(args: ToolArgs): Promise<CallToolResult> {
  const testFileOrDir = requireExistingPath(requireString(args, "testFileOrDir"), "testFileOrDir");
  const result = await runCmaj(["test", testFileOrDir], DEFAULT_TIMEOUT_MS);
  const output = combinedOutput(result);
  const summary = parseTestSummary(output);
  const failures = parseTestFailures(output);
  const diagnostics = parseDiagnostics(output);
  const ok = result.exitCode === 0
    && !result.timedOut
    && summary.failed === 0
    && diagnostics.every((diagnostic) => diagnostic.severity !== "error");

  return jsonResult({
    ok,
    testFileOrDir,
    summary,
    failures,
    diagnostics,
    command: summarizeCommand(result),
    stdout: result.stdout,
    stderr: result.stderr
  }, !ok);
}

async function createPatch(args: ToolArgs): Promise<CallToolResult> {
  const folder = path.resolve(requireString(args, "folder"));
  const name = requireString(args, "name");
  const ui = args.ui === undefined ? undefined : requireBoolean(args, "ui");
  const result = await runCmaj(["create", `--name=${name}`, folder], DEFAULT_TIMEOUT_MS);
  const diagnostics = parseDiagnostics(combinedOutput(result));
  const ok = result.exitCode === 0 && !result.timedOut && fs.existsSync(folder);

  return jsonResult({
    ok,
    folder,
    name,
    uiRequested: ui ?? false,
    warnings: ui ? ["The discovered cmaj create implementation only supports --name and has no UI scaffold flag."] : [],
    diagnostics,
    command: summarizeCommand(result),
    stdout: result.stdout,
    stderr: result.stderr
  }, !ok);
}

function runCmaj(args: string[], timeoutMs: number): Promise<CommandResult> {
  const command = process.env.CMAJ_BIN ? path.resolve(process.env.CMAJ_BIN) : path.normalize(DEFAULT_CMAJ_BIN);
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.on("error", (error) => {
      if (settled)
        return;

      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode: 1,
        signal: null,
        timedOut,
        stdout,
        stderr: stderr + (stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n") + errorMessage(error),
        durationMs: Date.now() - started
      });
    });

    child.on("close", (exitCode, signal) => {
      if (settled)
        return;

      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args,
        exitCode,
        signal,
        timedOut,
        stdout,
        stderr,
        durationMs: Date.now() - started
      });
    });
  });
}

function parseDiagnostics(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const lines = output.replace(/\r/g, "").split("\n");

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine).trim();

    if (line.length === 0)
      continue;

    let match = /^(.+):(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/i.exec(line);
    if (match !== null) {
      diagnostics.push({
        file: normalizeDiagnosticFile(match[1]),
        line: Number(match[2]),
        column: Number(match[3]),
        severity: normalizeSeverity(match[4]),
        message: match[5]
      });
      continue;
    }

    match = /^(.+):(\d+):\s*(error|warning|note):\s*(.+)$/i.exec(line);
    if (match !== null) {
      diagnostics.push({
        file: normalizeDiagnosticFile(match[1]),
        line: Number(match[2]),
        severity: normalizeSeverity(match[3]),
        message: match[4]
      });
      continue;
    }

    match = /^(\d+):(\d+):\s*(error|warning|note):\s*(.+)$/i.exec(line);
    if (match !== null) {
      diagnostics.push({
        line: Number(match[1]),
        column: Number(match[2]),
        severity: normalizeSeverity(match[3]),
        message: match[4]
      });
      continue;
    }

    match = /^(error|warning|note):\s*(.+)$/i.exec(line);
    if (match !== null) {
      diagnostics.push({
        severity: normalizeSeverity(match[1]),
        message: match[2]
      });
    }
  }

  return diagnostics;
}

function parseTestSummary(output: string): { passed: number; failed: number; disabled: number; unsupported: number; totalFiles: number | null } {
  return {
    passed: parseNamedCount(output, "Passed"),
    failed: parseNamedCount(output, "Failed"),
    disabled: parseNamedCount(output, "Disabled"),
    unsupported: parseNamedCount(output, "Unsupported"),
    totalFiles: parseOptionalNamedCount(output, "Total files")
  };
}

function parseTestFailures(output: string): JsonObject[] {
  const failures: JsonObject[] = [];
  const lines = output.replace(/\r/g, "").split("\n").map((line) => stripAnsi(line).trim()).filter(Boolean);

  for (const line of lines) {
    let match = /^(Test\s+\d+\s+\(line\s+\d+\))\s+FAILED(?:\s+(.*))?$/i.exec(line);
    if (match !== null) {
      failures.push({ test: match[1], message: match[2] ?? "" });
      continue;
    }

    match = /^(.+\.cmajtest):(\d+):(\d+):\s*error:\s*(.+)$/i.exec(line);
    if (match !== null) {
      failures.push({
        file: normalizeDiagnosticFile(match[1]),
        line: Number(match[2]),
        column: Number(match[3]),
        message: match[4]
      });
    }
  }

  return failures;
}

function parseEndpointsFromSource(sourceFile: string): EndpointInfo[] {
  const source = fs.readFileSync(sourceFile, "utf8");
  const cleaned = stripComments(source);
  const mainBodies = extractMainBodies(cleaned);
  const regions = mainBodies.length === 0 ? [{ body: cleaned, offset: 0 }] : mainBodies;
  const endpoints: EndpointInfo[] = [];

  for (const region of regions) {
    const groupedRanges: Array<{ start: number; end: number }> = [];
    const groupPattern = /\b(input|output)\s+(?:(stream|event|value)\s+)?\{([\s\S]*?)\}/g;
    let groupMatch: RegExpExecArray | null;

    while ((groupMatch = groupPattern.exec(region.body)) !== null) {
      groupedRanges.push({ start: groupMatch.index, end: groupMatch.index + groupMatch[0].length });
      const direction = groupMatch[1] as "input" | "output";
      const groupedType = groupMatch[2] as "stream" | "event" | "value" | undefined;
      const innerOffset = region.offset + groupMatch.index + groupMatch[0].indexOf(groupMatch[3]);
      const statements = splitStatements(groupMatch[3]);

      for (const statement of statements) {
        const parsed = parseEndpointSpec(direction, groupedType, statement.text, sourceFile, lineAt(cleaned, innerOffset + statement.offset));
        endpoints.push(...parsed);
      }
    }

    const bodyWithoutGroups = blankRanges(region.body, groupedRanges);
    const endpointPattern = /\b(input|output)\s+([^;{}]+);/g;
    let match: RegExpExecArray | null;

    while ((match = endpointPattern.exec(bodyWithoutGroups)) !== null) {
      const direction = match[1] as "input" | "output";
      const parsed = parseEndpointSpec(direction, undefined, match[2], sourceFile, lineAt(cleaned, region.offset + match.index));
      endpoints.push(...parsed);
    }
  }

  return endpoints;
}

function parseEndpointSpec(
  direction: "input" | "output",
  groupedType: "stream" | "event" | "value" | undefined,
  rawSpec: string,
  sourceFile: string,
  line: number
): EndpointInfo[] {
  let spec = rawSpec.trim();
  if (spec.length === 0)
    return [];

  const annotationMatch = /\[\[([\s\S]*?)\]\]\s*$/.exec(spec);
  const annotations = annotationMatch === null ? {} : parseAnnotations(annotationMatch[1]);
  if (annotationMatch !== null)
    spec = spec.slice(0, annotationMatch.index).trim();

  let endpointType: "stream" | "event" | "value" | "unknown" = groupedType ?? "unknown";
  const explicitType = /^(stream|event|value)\s+([\s\S]+)$/i.exec(spec);
  if (explicitType !== null) {
    endpointType = explicitType[1].toLowerCase() as "stream" | "event" | "value";
    spec = explicitType[2].trim();
  }

  const parsedNames = parseDataTypeAndNames(spec);

  return parsedNames.names.map((name) => {
    const cleanName = name.replace(/\[\s*\d+\s*\]$/, "").trim();
    return {
      id: cleanName,
      direction,
      type: endpointType,
      dataType: parsedNames.dataType,
      channels: endpointType === "stream" ? inferChannels(parsedNames.dataType, cleanName) : null,
      annotations,
      file: sourceFile,
      line
    };
  });
}

function parseDataTypeAndNames(spec: string): { dataType: string | null; names: string[] } {
  const trimmed = spec.trim();
  if (!/\s/.test(trimmed))
    return { dataType: null, names: [trimmed] };

  if (trimmed.startsWith("(")) {
    const close = findMatching(trimmed, 0, "(", ")");
    if (close > 0) {
      return {
        dataType: trimmed.slice(0, close + 1).trim(),
        names: splitTopLevel(trimmed.slice(close + 1).trim(), ",").map((name) => name.trim()).filter(Boolean)
      };
    }
  }

  const match = /^(.*?)\s+([A-Za-z_][A-Za-z0-9_.]*(?:\s*\[\s*\d+\s*\])?(?:\s*,\s*[A-Za-z_][A-Za-z0-9_.]*(?:\s*\[\s*\d+\s*\])?)*)$/.exec(trimmed);
  if (match === null)
    return { dataType: null, names: [trimmed] };

  return {
    dataType: match[1].trim(),
    names: splitTopLevel(match[2], ",").map((name) => name.trim()).filter(Boolean)
  };
}

function parseAnnotations(annotationText: string): JsonObject {
  const annotations: JsonObject = {};

  for (const part of splitTopLevel(annotationText, ",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0)
      continue;

    const colon = findTopLevelColon(trimmed);
    if (colon < 0) {
      annotations[trimmed] = true;
    } else {
      const key = trimmed.slice(0, colon).trim();
      annotations[key] = parseAnnotationValue(trimmed.slice(colon + 1).trim());
    }
  }

  return annotations;
}

function parseAnnotationValue(value: string): JsonValue {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
    return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\'/g, "'");

  if (/^(true|false)$/i.test(trimmed))
    return trimmed.toLowerCase() === "true";

  const numeric = trimmed.replace(/([0-9])f$/i, "$1");
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(numeric))
    return Number(numeric);

  return trimmed;
}

function extractMainBodies(source: string): Array<{ body: string; offset: number }> {
  const regions: Array<{ body: string; offset: number }> = [];
  const pattern = /\b(?:processor|graph)\s+[A-Za-z_][A-Za-z0-9_]*[^{;]*\[\[\s*main\b[\s\S]*?\]\][^{]*\{/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const openBrace = source.indexOf("{", match.index);
    const closeBrace = findMatching(source, openBrace, "{", "}");
    if (openBrace >= 0 && closeBrace > openBrace)
      regions.push({ body: source.slice(openBrace + 1, closeBrace), offset: openBrace + 1 });
  }

  return regions;
}

function readManifest(patchPath: string): JsonObject {
  const text = fs.readFileSync(patchPath, "utf8");
  const parsed = JSON.parse(text) as unknown;

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    fail(`Manifest is not a JSON object: ${patchPath}`);

  return parsed as JsonObject;
}

function resolveSourceFiles(patchPath: string, manifest: JsonObject): string[] {
  const source = manifest.source;
  const manifestDir = path.dirname(patchPath);
  const sources = typeof source === "string"
    ? [source]
    : Array.isArray(source) && source.every((entry) => typeof entry === "string")
      ? source
      : fail("Patch manifest must contain source as a string or string array.");

  return sources.map((entry) => requireExistingPath(path.resolve(manifestDir, entry), "manifest.source"));
}

function manifestSummary(manifest: JsonObject): JsonObject {
  const keys = [
    "CmajorVersion",
    "ID",
    "version",
    "name",
    "description",
    "manufacturer",
    "category",
    "isInstrument",
    "source",
    "view",
    "views",
    "worker",
    "resources"
  ];
  const summary: JsonObject = {};

  for (const key of keys)
    if (key in manifest)
      summary[key] = manifest[key];

  return summary;
}

function jsonResult(payload: unknown, isError: boolean): CallToolResult {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(toJson(payload), null, 2)
      }
    ]
  };
}

function toJson(value: unknown): JsonValue {
  if (value === null)
    return null;

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return value;

  if (value === undefined)
    return null;

  if (Array.isArray(value))
    return value.map((item) => toJson(item));

  if (typeof value === "object") {
    const result: JsonObject = {};

    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>))
      if (nestedValue !== undefined)
        result[key] = toJson(nestedValue);

    return result;
  }

  return String(value);
}

function summarizeCommand(result: CommandResult): JsonObject {
  return {
    command: result.command,
    args: result.args,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs
  };
}

function combinedOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`;
}

function asObject(value: unknown): ToolArgs {
  if (value === undefined || value === null)
    return {};

  if (typeof value !== "object" || Array.isArray(value))
    fail("Tool arguments must be an object.");

  return value as ToolArgs;
}

function requireString(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`Expected non-empty string argument: ${key}`);

  return value;
}

function requireBoolean(args: ToolArgs, key: string): boolean {
  const value = args[key];
  if (typeof value !== "boolean")
    fail(`Expected boolean argument: ${key}`);

  return value;
}

function requirePositiveInteger(args: ToolArgs, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    fail(`Expected positive integer argument: ${key}`);

  return value;
}

function requireExistingPath(inputPath: string, label: string): string {
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved))
    fail(`${label} does not exist: ${resolved}`);

  return resolved;
}

function fail(message: string): never {
  throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseNamedCount(output: string, name: string): number {
  return parseOptionalNamedCount(output, name) ?? 0;
}

function parseOptionalNamedCount(output: string, name: string): number | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped}:\\s+(\\d+)`, "im").exec(stripAnsi(output));
  return match === null ? null : Number(match[1]);
}

function normalizeSeverity(severity: string): Diagnostic["severity"] {
  const lower = severity.toLowerCase();
  return lower === "warning" || lower === "note" || lower === "error" ? lower : "info";
}

function normalizeDiagnosticFile(file: string): string {
  return file.trim().replace(/\\/g, "/");
}

function inferChannels(dataType: string | null, endpointID: string): number | null {
  if (dataType === null)
    return null;

  const vectorMatch = /<\s*(\d+)\s*>/.exec(dataType);
  if (vectorMatch !== null)
    return Number(vectorMatch[1]);

  const arrayMatch = /\[\s*(\d+)\s*\]$/.exec(endpointID);
  if (arrayMatch !== null)
    return Number(arrayMatch[1]);

  return /^(?:float|float32|float64|int|int32|int64)$/i.test(dataType.trim()) ? 1 : null;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function stripComments(source: string): string {
  let output = "";
  let i = 0;
  let inString: "'" | "\"" | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  while (i < source.length) {
    const current = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (current === "\n") {
        inLineComment = false;
        output += current;
      } else {
        output += " ";
      }
      i++;
      continue;
    }

    if (inBlockComment) {
      if (current === "*" && next === "/") {
        output += "  ";
        i += 2;
        inBlockComment = false;
      } else {
        output += current === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    if (inString !== null) {
      output += current;
      if (current === "\\") {
        output += next ?? "";
        i += 2;
        continue;
      }
      if (current === inString)
        inString = null;
      i++;
      continue;
    }

    if (current === "\"" || current === "'") {
      inString = current;
      output += current;
      i++;
      continue;
    }

    if (current === "/" && next === "/") {
      output += "  ";
      i += 2;
      inLineComment = true;
      continue;
    }

    if (current === "/" && next === "*") {
      output += "  ";
      i += 2;
      inBlockComment = true;
      continue;
    }

    output += current;
    i++;
  }

  return output;
}

function splitStatements(text: string): Array<{ text: string; offset: number }> {
  const statements: Array<{ text: string; offset: number }> = [];
  let start = 0;
  let depthAngle = 0;
  let depthParen = 0;
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote !== null) {
      if (char === "\\")
        i++;
      else if (char === quote)
        quote = null;
      continue;
    }

    if (char === "\"" || char === "'") quote = char;
    else if (char === "<") depthAngle++;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);
    else if (char === "(") depthParen++;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === ";" && depthAngle === 0 && depthParen === 0) {
      statements.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0)
    statements.push({ text: tail, offset: start });

  return statements;
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depthParen = 0;
  let depthAngle = 0;
  let depthBracket = 0;
  let quote: "'" | "\"" | null = null;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote !== null) {
      if (char === "\\")
        i++;
      else if (char === quote)
        quote = null;
      continue;
    }

    if (char === "\"" || char === "'") quote = char;
    else if (char === "(") depthParen++;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "<") depthAngle++;
    else if (char === ">") depthAngle = Math.max(0, depthAngle - 1);
    else if (char === "[") depthBracket++;
    else if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (char === delimiter && depthParen === 0 && depthAngle === 0 && depthBracket === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));
  return parts;
}

function findTopLevelColon(text: string): number {
  let quote: "'" | "\"" | null = null;
  let depthParen = 0;
  let depthBracket = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quote !== null) {
      if (char === "\\")
        i++;
      else if (char === quote)
        quote = null;
      continue;
    }

    if (char === "\"" || char === "'") quote = char;
    else if (char === "(") depthParen++;
    else if (char === ")") depthParen = Math.max(0, depthParen - 1);
    else if (char === "[") depthBracket++;
    else if (char === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (char === ":" && depthParen === 0 && depthBracket === 0) return i;
  }

  return -1;
}

function findMatching(text: string, openIndex: number, open: string, close: string): number {
  let depth = 0;
  let quote: "'" | "\"" | null = null;

  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];

    if (quote !== null) {
      if (char === "\\")
        i++;
      else if (char === quote)
        quote = null;
      continue;
    }

    if (char === "\"" || char === "'") quote = char;
    else if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0)
        return i;
    }
  }

  return -1;
}

function blankRanges(text: string, ranges: Array<{ start: number; end: number }>): string {
  const chars = [...text];
  for (const range of ranges) {
    for (let i = range.start; i < range.end; i++)
      if (chars[i] !== "\n")
        chars[i] = " ";
  }
  return chars.join("");
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++)
    if (text[i] === "\n")
      line++;
  return line;
}
