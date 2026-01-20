import { describe, expect, it, vi, beforeEach } from "vitest";

import type { SkillCommandSpec } from "../../agents/skills.js";
import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { InlineDirectives } from "./directive-handling.js";
import { parseInlineDirectives } from "./directive-handling.js";
import type { TypingController } from "./typing.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";

vi.mock("../../agents/clawdbot-tools.js", () => ({
  createClawdbotTools: vi.fn(),
}));

import { createClawdbotTools } from "../../agents/clawdbot-tools.js";

const mockedCreateClawdbotTools = vi.mocked(createClawdbotTools);

const createTypingController = (): TypingController => ({
  onReplyStart: vi.fn(),
  startTypingLoop: vi.fn(),
  startTypingOnText: vi.fn(),
  refreshTypingTtl: vi.fn(),
  isActive: vi.fn(() => false),
  markRunComplete: vi.fn(),
  markDispatchIdle: vi.fn(),
  cleanup: vi.fn(),
});

const baseCommand = {
  surface: "slack",
  channel: "slack",
  ownerList: [],
  isAuthorizedSender: true,
  rawBodyNormalized: "/dispatch",
  commandBodyNormalized: "/dispatch",
  senderId: "user-1",
};

const baseDirectives = parseInlineDirectives("/dispatch") as InlineDirectives;

function createParams(overrides: Partial<Parameters<typeof handleInlineActions>[0]> = {}) {
  const cfg = (overrides.cfg ??
    ({
      tools: {
        allow: ["tool_allowed"],
      },
    } as ClawdbotConfig)) as ClawdbotConfig;
  return {
    ctx: {
      Surface: "slack",
      Provider: "slack",
      AccountId: "default",
    } satisfies MsgContext as MsgContext,
    sessionCtx: {
      Body: "",
      BodyForAgent: "",
      BodyStripped: "",
    } satisfies TemplateContext as TemplateContext,
    cfg,
    agentId: "main",
    agentDir: "/tmp",
    sessionEntry: undefined,
    previousSessionEntry: undefined,
    sessionStore: undefined,
    sessionKey: "main",
    storePath: undefined,
    sessionScope: "per-sender",
    workspaceDir: "/tmp",
    isGroup: false,
    opts: undefined,
    typing: createTypingController(),
    allowTextCommands: true,
    inlineStatusRequested: false,
    command: baseCommand,
    skillCommands: [],
    directives: baseDirectives,
    cleanedBody: "/dispatch",
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultActivation: () => "always",
    resolvedThinkLevel: "off",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-4o-mini",
    contextTokens: 0,
    directiveAck: undefined,
    abortedLastRun: false,
    skillFilter: undefined,
    ...overrides,
  };
}

function createTool(name: string, execute: AnyAgentTool["execute"]): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: {},
    execute,
  } as AnyAgentTool;
}

describe("handleInlineActions tool-dispatch", () => {
  beforeEach(() => {
    mockedCreateClawdbotTools.mockReset();
  });

  it("returns media payloads from tool results", async () => {
    const tool = createTool("tool_allowed", async () => ({
      content: [{ type: "text", text: "Done\nMEDIA:/tmp/photo.jpg" }],
    }));
    mockedCreateClawdbotTools.mockReturnValue([tool]);

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "dispatch",
        skillName: "dispatch",
        description: "Dispatch",
        dispatch: { kind: "tool", toolName: "tool_allowed", argMode: "raw" },
      },
    ];

    const result = await handleInlineActions(
      createParams({
        command: { ...baseCommand, commandBodyNormalized: "/dispatch hi" },
        skillCommands,
        cleanedBody: "/dispatch hi",
      }),
    );

    expect(result.kind).toBe("reply");
    const reply = (result as { reply?: unknown }).reply as { text?: string; mediaUrl?: string };
    expect(reply.text).toBe("Done");
    expect(reply.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("blocks tool dispatch when policy disallows the tool", async () => {
    const allowed = createTool("tool_allowed", async () => ({ content: "ok" }));
    const blocked = createTool("tool_blocked", async () => ({ content: "nope" }));
    mockedCreateClawdbotTools.mockReturnValue([allowed, blocked]);

    const cfg = {
      tools: {
        allow: ["tool_allowed"],
      },
    } as ClawdbotConfig;

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "dispatch",
        skillName: "dispatch",
        description: "Dispatch",
        dispatch: { kind: "tool", toolName: "tool_blocked", argMode: "raw" },
      },
    ];

    const result = await handleInlineActions(
      createParams({
        cfg,
        skillCommands,
        command: { ...baseCommand, commandBodyNormalized: "/dispatch arg" },
        cleanedBody: "/dispatch arg",
      }),
    );

    expect(result.kind).toBe("reply");
    const reply = (result as { reply?: { text?: string; isError?: boolean } }).reply;
    expect(reply?.text).toContain("Tool blocked by policy");
    expect(reply?.isError).toBe(true);
  });
});
