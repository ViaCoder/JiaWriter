import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { uiText } from "../../../writer/ui-text.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";
// JiaWriter: a reply behind its mark.
import { Prefixed } from "./prefixed.ts";

/**
 * JiaWriter: the detailed view (Ctrl+O), shared by every reply on screen: the thinking is shown, and each reply
 * starts with its time and model, as in Claude Code's transcript view.
 */
let detailedView = false;

/** Turn the detailed view on or off; the replies on screen redraw with their next update. */
export function setDetailedView(on: boolean): void {
	detailedView = on;
}

/** The time and model of a reply, as the detailed view shows them. */
export function replyHeader(message: Pick<AssistantMessage, "timestamp" | "model" | "responseModel">): string {
	const time = new Date(message.timestamp).toLocaleTimeString("zh-CN", { hour12: false });
	return `${time} · ${message.responseModel ?? message.model}`;
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		// JiaWriter (2026-11-17): a collapsed thinking run is drawn as nothing, not as a "collapsed" line, so it counts as
		// visible only when it is shown (the detailed view, or a run clicked open earlier).
		const thinkingShown = !this.hideThinkingBlock || detailedView;
		const visible = (c: AssistantMessage["content"][number]): boolean =>
			(c.type === "text" && !!c.text.trim()) || (c.type === "thinking" && thinkingShown && !!c.thinking.trim());
		const hasVisibleContent = message.content.some(visible);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
			if (detailedView)
				this.contentContainer.addChild(new Text(theme.fg("dim", replyHeader(message)), this.outputPad, 0));
		}

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				// JiaWriter: each reply behind its mark, as Claude Code draws a reply (2026-11-15).
				this.contentContainer.addChild(
					new Prefixed(
						new Markdown(content.text.trim(), 0, 0, this.markdownTheme, undefined, {
							transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
						}),
						{
							marker: () => `${" ".repeat(this.outputPad)}${theme.fg("accent", "● ")}`,
							indent: this.outputPad + 2,
						},
					),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content.slice(i + 1).some(visible);

				// A hidden run takes no room at all: no "collapsed" line, nothing to click (the user, 2026-11-17).
				if (!thinkingShown) continue;
				this.contentContainer.addChild(
					new Markdown(
						thinkingBlocks.join("\n\n"),
						this.outputPad,
						0,
						this.markdownTheme,
						{
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						},
						{
							transform: createMarkdownTransform(
								"assistant-thinking",
								this.isStreaming,
								this.markdownTransformers,
							),
						},
					),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", uiText("Response was truncated before completion.")), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: uiText("Operation aborted");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = uiText(message.errorMessage || "Unknown error");
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("error", uiText("Error: {message}", { message: errorMsg })), this.outputPad, 0),
				);
			}
		}
	}
}
