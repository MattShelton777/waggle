import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import {
  CheckInputSchema,
  DiscoverInputSchema,
  GetRulesInputSchema,
  InspectInputSchema,
  LogUseInputSchema,
  OpenTestsInputSchema,
  PlaybooksInputSchema,
  ReportInputSchema,
} from "@waggle/core";
import type { ZodType } from "zod";
import { buildNotices, loadContext, WaggleError, type Deps, type RequestContext } from "./context";
import { check, discover, getRules, inspect, openTests, playbooks } from "./read-tools";
import { SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION, TOOL_TEXT } from "./text";
import { logUse, report } from "./write-tools";

// MCP wiring. Edge Functions are stateless, so a fresh server is built per
// request with the authenticated subscriber closed over.

type ToolName = keyof typeof TOOL_TEXT;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// Writes only ever append evidence; nothing can be updated or deleted.
const APPEND_ONLY = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

export function buildServer(deps: Deps, subscriberId: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });

  let ctxPromise: Promise<RequestContext> | undefined;
  const ctx = () => (ctxPromise ??= loadContext(deps, subscriberId));

  const run = async <A extends { rules_version_seen?: number | undefined }>(
    tool: ToolName,
    args: A,
    fn: (c: RequestContext, a: A) => Promise<Record<string, unknown>>,
  ) => {
    const started = Date.now();
    let c: RequestContext | undefined;
    try {
      c = await ctx();
      const result = await fn(c, args);
      const seen = tool === "waggle_get_rules" ? c.rulesVersion : args.rules_version_seen;
      const [notices] = await Promise.all([
        buildNotices(c, seen),
        c.db.touchSubscriber(subscriberId, seen),
        c.db.logCall(subscriberId, tool, Date.now() - started, resultCount(result), true),
      ]);
      const body = { ...result, notices };
      return { content: [{ type: "text" as const, text: JSON.stringify(body) }], structuredContent: body };
    } catch (err) {
      await deps.db.logCall(c ? subscriberId : null, tool, Date.now() - started, null, false).catch(() => {});
      if (err instanceof WaggleError) {
        const body = { error: err.code, message: err.message };
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(body) }] };
      }
      console.error(`waggle tool ${tool} failed`, err);
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ error: "internal", message: "Waggle hit an internal error. Try again shortly." }) }] };
    }
  };

  const reg = (
    name: ToolName,
    inputSchema: ZodType,
    annotations: typeof READ_ONLY | typeof APPEND_ONLY,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fn: (c: RequestContext, a: any) => Promise<Record<string, unknown>>,
  ) =>
    server.registerTool(
      name,
      {
        title: TOOL_TEXT[name].title,
        description: TOOL_TEXT[name].description,
        // The strict Zod schemas from core: advertised as JSON Schema and validated by the SDK.
        inputSchema: inputSchema as never,
        annotations: { title: TOOL_TEXT[name].title, ...annotations },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ((args: any) => run(name, args ?? {}, fn)) as never,
    );

  reg("waggle_get_rules", GetRulesInputSchema, READ_ONLY, (c) => getRules(c));
  reg("waggle_check", CheckInputSchema, READ_ONLY, check);
  reg("waggle_discover", DiscoverInputSchema, READ_ONLY, discover);
  reg("waggle_inspect", InspectInputSchema, READ_ONLY, inspect);
  reg("waggle_playbooks", PlaybooksInputSchema, READ_ONLY, playbooks);
  reg("waggle_open_tests", OpenTestsInputSchema, READ_ONLY, openTests);
  reg("waggle_log_use", LogUseInputSchema, APPEND_ONLY, logUse);
  reg("waggle_report", ReportInputSchema, APPEND_ONLY, (c, a) => report(c, a) as Promise<Record<string, unknown>>);

  return server;
}

function resultCount(result: Record<string, unknown>): number | null {
  return typeof result.result_count === "number" ? result.result_count : null;
}

/** Serve one MCP HTTP request for an authenticated subscriber. */
export function handleMcpRequest(deps: Deps, subscriberId: string, request: Request): Promise<Response> {
  return createMcpHandler(() => buildServer(deps, subscriberId)).fetch(request);
}
