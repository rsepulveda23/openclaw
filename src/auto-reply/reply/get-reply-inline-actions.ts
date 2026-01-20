import { pathToFileURL } from "node:url";

import { getChannelDock } from "../../channels/dock.js";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { AnyAgentTool } from "../../agents/pi-tools.types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import {
  resolveSubagentToolPolicy,
  resolveEffectiveToolPolicy,
  filterToolsByPolicy,
} from "../../agents/pi-tools.policy.js";
import {
  buildPluginToolGroups,
  collectExplicitAllowlist,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "../../agents/tool-policy.js";
import {
  resolveSandboxRuntimeStatus,
  formatSandboxToolPolicyBlockedMessage,
} from "../../agents/sandbox/runtime-status.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveUserPath } from "../../utils.js";
import { getAbortMemory } from "./abort.js";
import { buildStatusReply, handleCommands } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { isDirectiveOnly } from "./directive-handling.js";
import type { createModelSelectionState } from "./model-selection.js";
import { extractInlineSimpleCommand } from "./reply-inline.js";
import { parseReplyDirectives } from "./reply-directives.js";
import type { TypingController } from "./typing.js";
import { listSkillCommandsForWorkspace, resolveSkillCommandInvocation } from "../skill-commands.js";
import { logVerbose } from "../../globals.js";
import { createClawdbotTools } from "../../agents/clawdbot-tools.js";
import {
  resolveGatewayMessageChannel,
  type GatewayMessageChannel,
} from "../../utils/message-channel.js";
import { getPluginToolMeta } from "../../plugins/tools.js";

export type InlineActionResult =
  | { kind: "reply"; reply: ReplyPayload | ReplyPayload[] | undefined }
  | {
      kind: "continue";
      directives: InlineDirectives;
      abortedLastRun: boolean;
    };

function normalizeMediaUrlCandidate(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("file://")) return trimmed;
  const resolved = trimmed.startsWith("~") ? resolveUserPath(trimmed) : trimmed;
  if (resolved.startsWith("/")) {
    return pathToFileURL(resolved).toString();
  }
  if (resolved.startsWith("./") || resolved.startsWith("../")) return resolved;
  return trimmed;
}

function extractTextFromToolResultContent(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim();
    return trimmed ? trimmed : null;
  }
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: unknown; text?: unknown };
    if (rec.type === "text" && typeof rec.text === "string") {
      parts.push(rec.text);
    }
  }
  const out = parts.join("\n").trim();
  return out ? out : null;
}

function extractMediaUrlsFromDetails(details: unknown): string[] {
  if (!details || typeof details !== "object") return [];
  const record = details as Record<string, unknown>;
  const candidates: string[] = [];
  const mediaUrls = record.mediaUrls;
  if (Array.isArray(mediaUrls)) {
    for (const entry of mediaUrls) {
      if (typeof entry === "string") candidates.push(entry);
    }
  }
  const mediaUrl = record.mediaUrl;
  if (typeof mediaUrl === "string") candidates.push(mediaUrl);
  const media = record.media;
  if (typeof media === "string") candidates.push(media);
  const path = record.path;
  if (typeof path === "string") candidates.push(path);
  return candidates
    .map((entry) => normalizeMediaUrlCandidate(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function extractReplyPayloadFromToolResult(result: unknown): ReplyPayload | null {
  if (!result || typeof result !== "object") return null;

  const maybePayload = result as ReplyPayload & { content?: unknown; details?: unknown };
  if (
    typeof maybePayload.text === "string" ||
    typeof maybePayload.mediaUrl === "string" ||
    Array.isArray(maybePayload.mediaUrls)
  ) {
    return {
      text: maybePayload.text?.trim() ? maybePayload.text.trim() : undefined,
      mediaUrl: maybePayload.mediaUrl,
      mediaUrls: maybePayload.mediaUrls,
      replyToId: maybePayload.replyToId,
      replyToTag: maybePayload.replyToTag,
      replyToCurrent: maybePayload.replyToCurrent,
      audioAsVoice: maybePayload.audioAsVoice,
      isError: maybePayload.isError,
    };
  }

  const content = maybePayload.content;
  const text = extractTextFromToolResultContent(content);
  const parsed = text
    ? parseReplyDirectives(text)
    : {
        text: "",
        mediaUrls: undefined,
        mediaUrl: undefined,
        replyToId: undefined,
        replyToCurrent: false,
        replyToTag: false,
        audioAsVoice: undefined,
        isSilent: false,
      };

  if (parsed.isSilent) return null;

  const mediaFromText = parsed.mediaUrls ?? (parsed.mediaUrl ? [parsed.mediaUrl] : []);
  const mediaFromDetails = extractMediaUrlsFromDetails(maybePayload.details);
  const mediaUrls = Array.from(new Set([...mediaFromText, ...mediaFromDetails]))
    .map((entry) => normalizeMediaUrlCandidate(entry))
    .filter((entry): entry is string => Boolean(entry));

  const cleanedText = parsed.text?.trim() ? parsed.text.trim() : undefined;
  if (!cleanedText && mediaUrls.length === 0) return null;

  return {
    text: cleanedText,
    mediaUrls: mediaUrls.length ? mediaUrls : undefined,
    mediaUrl: mediaUrls[0],
    replyToId: parsed.replyToId,
    replyToTag: parsed.replyToTag,
    replyToCurrent: parsed.replyToCurrent,
    audioAsVoice: parsed.audioAsVoice,
    isError: (result as { isError?: unknown }).isError === true,
  };
}

function resolveToolDispatchTools(params: {
  cfg: ClawdbotConfig;
  sessionKey: string;
  provider: string;
  model: string;
  agentDir?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  workspaceDir: string;
}): {
  allTools: AnyAgentTool[];
  allowedTools: AnyAgentTool[];
  sandboxed: boolean;
} {
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
  });
  const {
    profile,
    providerProfile,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
  } = resolveEffectiveToolPolicy({
    config: params.cfg,
    sessionKey: params.sessionKey,
    modelProvider: params.provider,
    modelId: params.model,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const subagentPolicy =
    isSubagentSessionKey(params.sessionKey) && params.sessionKey
      ? resolveSubagentToolPolicy(params.cfg)
      : undefined;
  const pluginToolAllowlist = collectExplicitAllowlist([
    profilePolicy,
    providerProfilePolicy,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    sandboxPolicy,
    subagentPolicy,
  ]);

  const allTools = createClawdbotTools({
    agentSessionKey: params.sessionKey,
    agentChannel: params.agentChannel,
    agentAccountId: params.agentAccountId,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    config: params.cfg,
    sandboxed: sandboxRuntime.sandboxed,
    pluginToolAllowlist,
  }) as AnyAgentTool[];

  const pluginGroups = buildPluginToolGroups({
    tools: allTools,
    toolMeta: (tool) => getPluginToolMeta(tool),
  });
  const profilePolicyExpanded = expandPolicyWithPluginGroups(profilePolicy, pluginGroups);
  const providerProfilePolicyExpanded = expandPolicyWithPluginGroups(
    providerProfilePolicy,
    pluginGroups,
  );
  const globalPolicyExpanded = expandPolicyWithPluginGroups(globalPolicy, pluginGroups);
  const globalProviderPolicyExpanded = expandPolicyWithPluginGroups(
    globalProviderPolicy,
    pluginGroups,
  );
  const agentPolicyExpanded = expandPolicyWithPluginGroups(agentPolicy, pluginGroups);
  const agentProviderPolicyExpanded = expandPolicyWithPluginGroups(
    agentProviderPolicy,
    pluginGroups,
  );
  const sandboxPolicyExpanded = expandPolicyWithPluginGroups(sandboxPolicy, pluginGroups);
  const subagentPolicyExpanded = expandPolicyWithPluginGroups(subagentPolicy, pluginGroups);

  const toolsFiltered = profilePolicyExpanded
    ? filterToolsByPolicy(allTools, profilePolicyExpanded)
    : allTools;
  const providerProfileFiltered = providerProfilePolicyExpanded
    ? filterToolsByPolicy(toolsFiltered, providerProfilePolicyExpanded)
    : toolsFiltered;
  const globalFiltered = globalPolicyExpanded
    ? filterToolsByPolicy(providerProfileFiltered, globalPolicyExpanded)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderPolicyExpanded
    ? filterToolsByPolicy(globalFiltered, globalProviderPolicyExpanded)
    : globalFiltered;
  const agentFiltered = agentPolicyExpanded
    ? filterToolsByPolicy(globalProviderFiltered, agentPolicyExpanded)
    : globalProviderFiltered;
  const agentProviderFiltered = agentProviderPolicyExpanded
    ? filterToolsByPolicy(agentFiltered, agentProviderPolicyExpanded)
    : agentFiltered;
  const sandboxed = sandboxPolicyExpanded
    ? filterToolsByPolicy(agentProviderFiltered, sandboxPolicyExpanded)
    : agentProviderFiltered;
  const subagentFiltered = subagentPolicyExpanded
    ? filterToolsByPolicy(sandboxed, subagentPolicyExpanded)
    : sandboxed;

  return {
    allTools,
    allowedTools: subagentFiltered,
    sandboxed: sandboxRuntime.sandboxed,
  };
}

export async function handleInlineActions(params: {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: ClawdbotConfig;
  agentId: string;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  previousSessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
  sessionScope: Parameters<typeof buildStatusReply>[0]["sessionScope"];
  workspaceDir: string;
  isGroup: boolean;
  opts?: GetReplyOptions;
  typing: TypingController;
  allowTextCommands: boolean;
  inlineStatusRequested: boolean;
  command: Parameters<typeof handleCommands>[0]["command"];
  skillCommands?: SkillCommandSpec[];
  directives: InlineDirectives;
  cleanedBody: string;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  elevatedFailures: Array<{ gate: string; key: string }>;
  defaultActivation: Parameters<typeof buildStatusReply>[0]["defaultGroupActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  resolveDefaultThinkingLevel: Awaited<
    ReturnType<typeof createModelSelectionState>
  >["resolveDefaultThinkingLevel"];
  provider: string;
  model: string;
  contextTokens: number;
  directiveAck?: ReplyPayload;
  abortedLastRun: boolean;
  skillFilter?: string[];
}): Promise<InlineActionResult> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    directives: initialDirectives,
    cleanedBody: initialCleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun: initialAbortedLastRun,
    skillFilter,
  } = params;

  let directives = initialDirectives;
  let cleanedBody = initialCleanedBody;

  const shouldLoadSkillCommands = command.commandBodyNormalized.startsWith("/");
  const skillCommands =
    shouldLoadSkillCommands && params.skillCommands
      ? params.skillCommands
      : shouldLoadSkillCommands
        ? listSkillCommandsForWorkspace({
            workspaceDir,
            cfg,
            skillFilter,
          })
        : [];

  const skillInvocation =
    allowTextCommands && skillCommands.length > 0
      ? resolveSkillCommandInvocation({
          commandBodyNormalized: command.commandBodyNormalized,
          skillCommands,
        })
      : null;
  if (skillInvocation) {
    if (!command.isAuthorizedSender) {
      logVerbose(
        `Ignoring /${skillInvocation.command.name} from unauthorized sender: ${command.senderId || "<unknown>"}`,
      );
      typing.cleanup();
      return { kind: "reply", reply: undefined };
    }

    const dispatch = skillInvocation.command.dispatch;
    if (dispatch?.kind === "tool") {
      const rawArgs = (skillInvocation.args ?? "").trim();
      const channel =
        resolveGatewayMessageChannel(ctx.Surface) ??
        resolveGatewayMessageChannel(ctx.Provider) ??
        undefined;
      const { allTools, allowedTools } = resolveToolDispatchTools({
        cfg,
        sessionKey,
        provider,
        model,
        agentDir,
        agentChannel: channel,
        agentAccountId: (ctx as { AccountId?: string }).AccountId,
        workspaceDir,
      });
      const requestedName = normalizeToolName(dispatch.toolName);
      const findTool = (tools: AnyAgentTool[]) =>
        tools.find((candidate) => normalizeToolName(candidate.name) === requestedName);
      const tool = findTool(allowedTools);
      if (!tool) {
        const allTool = findTool(allTools);
        if (allTool) {
          const sandboxReason = formatSandboxToolPolicyBlockedMessage({
            cfg,
            sessionKey,
            toolName: requestedName,
          });
          const message = sandboxReason
            ? `❌ Tool blocked by policy: ${dispatch.toolName}\n${sandboxReason}`
            : `❌ Tool blocked by policy: ${dispatch.toolName}`;
          typing.cleanup();
          return { kind: "reply", reply: { text: message, isError: true } };
        }
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ Tool not available: ${dispatch.toolName}` } };
      }

      const toolCallId = `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      try {
        const result = await tool.execute(toolCallId, {
          command: rawArgs,
          commandName: skillInvocation.command.name,
          skillName: skillInvocation.command.skillName,
        } as any);
        const reply = extractReplyPayloadFromToolResult(result) ?? { text: "✅ Done." };
        typing.cleanup();
        return { kind: "reply", reply };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        typing.cleanup();
        return { kind: "reply", reply: { text: `❌ ${message}`, isError: true } };
      }
    }

    const promptParts = [
      `Use the "${skillInvocation.command.skillName}" skill for this request.`,
      skillInvocation.args ? `User input:\n${skillInvocation.args}` : null,
    ].filter((entry): entry is string => Boolean(entry));
    const rewrittenBody = promptParts.join("\n\n");
    ctx.Body = rewrittenBody;
    ctx.BodyForAgent = rewrittenBody;
    sessionCtx.Body = rewrittenBody;
    sessionCtx.BodyForAgent = rewrittenBody;
    sessionCtx.BodyStripped = rewrittenBody;
    cleanedBody = rewrittenBody;
  }

  const sendInlineReply = async (reply?: ReplyPayload) => {
    if (!reply) return;
    if (!opts?.onBlockReply) return;
    await opts.onBlockReply(reply);
  };

  const inlineCommand =
    allowTextCommands && command.isAuthorizedSender
      ? extractInlineSimpleCommand(cleanedBody)
      : null;
  if (inlineCommand) {
    cleanedBody = inlineCommand.cleaned;
    sessionCtx.Body = cleanedBody;
    sessionCtx.BodyForAgent = cleanedBody;
    sessionCtx.BodyStripped = cleanedBody;
  }

  const handleInlineStatus =
    !isDirectiveOnly({
      directives,
      cleanedBody: directives.cleaned,
      ctx,
      cfg,
      agentId,
      isGroup,
    }) && inlineStatusRequested;
  if (handleInlineStatus) {
    const inlineStatusReply = await buildStatusReply({
      cfg,
      command,
      sessionEntry,
      sessionKey,
      sessionScope,
      provider,
      model,
      contextTokens,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      isGroup,
      defaultGroupActivation: defaultActivation,
      mediaDecisions: ctx.MediaUnderstandingDecisions,
    });
    await sendInlineReply(inlineStatusReply);
    directives = { ...directives, hasStatusDirective: false };
  }

  if (inlineCommand) {
    const inlineCommandContext = {
      ...command,
      rawBodyNormalized: inlineCommand.command,
      commandBodyNormalized: inlineCommand.command,
    };
    const inlineResult = await handleCommands({
      ctx,
      cfg,
      command: inlineCommandContext,
      agentId,
      directives,
      elevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        failures: elevatedFailures,
      },
      sessionEntry,
      previousSessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      sessionScope,
      workspaceDir,
      defaultGroupActivation: defaultActivation,
      resolvedThinkLevel,
      resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      resolveDefaultThinkingLevel,
      provider,
      model,
      contextTokens,
      isGroup,
      skillCommands,
    });
    if (inlineResult.reply) {
      if (!inlineCommand.cleaned) {
        typing.cleanup();
        return { kind: "reply", reply: inlineResult.reply };
      }
      await sendInlineReply(inlineResult.reply);
    }
  }

  if (directiveAck) {
    await sendInlineReply(directiveAck);
  }

  const isEmptyConfig = Object.keys(cfg).length === 0;
  const skipWhenConfigEmpty = command.channelId
    ? Boolean(getChannelDock(command.channelId)?.commands?.skipWhenConfigEmpty)
    : false;
  if (
    skipWhenConfigEmpty &&
    isEmptyConfig &&
    command.from &&
    command.to &&
    command.from !== command.to
  ) {
    typing.cleanup();
    return { kind: "reply", reply: undefined };
  }

  let abortedLastRun = initialAbortedLastRun;
  if (!sessionEntry && command.abortKey) {
    abortedLastRun = getAbortMemory(command.abortKey) ?? false;
  }

  const commandResult = await handleCommands({
    ctx,
    cfg,
    command,
    agentId,
    directives,
    elevated: {
      enabled: elevatedEnabled,
      allowed: elevatedAllowed,
      failures: elevatedFailures,
    },
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    defaultGroupActivation: defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    isGroup,
    skillCommands,
  });
  if (!commandResult.shouldContinue) {
    typing.cleanup();
    return { kind: "reply", reply: commandResult.reply };
  }

  return {
    kind: "continue",
    directives,
    abortedLastRun,
  };
}
