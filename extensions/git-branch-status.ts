import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function addUsage(totals: UsageTotals, usage: Usage | undefined): void {
	if (!usage) return;
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.cost += usage.cost.total;
}

function getUsageTotals(ctx: ExtensionContext): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type === "usage") {
			addUsage(totals, entry.usage);
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			addUsage(totals, (entry.message as AssistantMessage).usage);
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			addUsage(totals, entry.message.usage);
		} else if (entry.type === "branch_summary" || entry.type === "compaction") {
			addUsage(totals, entry.usage);
		}
	}

	return totals;
}

function formatTokens(count: number): string {
	if (count < 1_000) return `${count}`;
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

function sanitizeStatus(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

export default function gitBranchStatusExtension(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			function branchPill(branch: string, maximumWidth: number): string {
				const detached = branch === "detached";
				const color = detached
					? "warning"
					: branch === "main" || branch === "master"
						? "success"
						: "accent";
				const label = truncateToWidth(branch, Math.max(1, maximumWidth - 4), "…");
				const cap = (text: string) => theme.fg(color, text);
				const body = theme.inverse(theme.fg(color, theme.bold(` ${label} `)));
				return `${cap("")}${body}${cap("")}`;
			}

			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					const sessionName = ctx.sessionManager.getSessionName();
					const sessionSuffix = sessionName ? theme.fg("dim", ` • ${sessionName}`) : "";
					const sessionSuffixWidth = visibleWidth(sessionSuffix);

					let firstLine: string;
					if (branch && width >= 8) {
						const maximumPillWidth = Math.max(6, Math.min(visibleWidth(branch) + 4, Math.floor(width * 0.45)));
						const pill = branchPill(branch, maximumPillWidth);
						const suffixWidth = 1 + visibleWidth(pill) + sessionSuffixWidth;
						const pathWidth = Math.max(1, width - suffixWidth);
						const path = truncateToWidth(ctx.cwd, pathWidth, "…");
						firstLine = `${theme.fg("dim", path)} ${pill}${sessionSuffix}`;
					} else {
						firstLine = `${theme.fg("dim", ctx.cwd)}${sessionSuffix}`;
					}
					firstLine = truncateToWidth(firstLine, width, theme.fg("dim", "…"));

					const totals = getUsageTotals(ctx);
					const usageParts: string[] = [];
					if (totals.input) usageParts.push(`↑${formatTokens(totals.input)}`);
					if (totals.output) usageParts.push(`↓${formatTokens(totals.output)}`);
					if (totals.cacheRead) usageParts.push(`R${formatTokens(totals.cacheRead)}`);
					if (totals.cacheWrite) usageParts.push(`W${formatTokens(totals.cacheWrite)}`);
					if (totals.cost) usageParts.push(`$${totals.cost.toFixed(3)}`);

					const context = ctx.getContextUsage();
					const contextWindow = context?.contextWindow ?? ctx.model?.contextWindow;
					if (contextWindow) {
						const percentage = context?.percent === null || context?.percent === undefined
							? "?"
							: context.percent.toFixed(1);
						usageParts.push(`${percentage}%/${formatTokens(contextWindow)}`);
					}

					const left = theme.fg("dim", usageParts.join(" "));
					const modelName = ctx.model?.id ?? "no-model";
					const thinking = ctx.model?.reasoning ? ` • ${ctx.thinkingLevel ?? "off"}` : "";
					const provider = footerData.getAvailableProviderCount() > 1 && ctx.model ? `(${ctx.model.provider}) ` : "";
					const extensionStatuses = footerData.getExtensionStatuses();
					const workMode = extensionStatuses.get("work-mode");
					const doneIndicator = extensionStatuses.get("zz-done-indicator");
					const modelStatus = theme.fg("dim", `${provider}${modelName}${thinking}`);
					const modeStatus = workMode ? `${theme.fg("dim", " • ")}${sanitizeStatus(workMode)}` : "";
					const availableRight = Math.max(0, width - visibleWidth(left) - 2);
					const right = truncateToWidth(`${modelStatus}${modeStatus}`, availableRight, "");
					const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
					const lines = [firstLine, `${left}${padding}${right}`];

					const statuses = Array.from(extensionStatuses.entries())
						.filter(([key]) => key !== "work-mode" && key !== "zz-done-indicator")
						.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
						.map(([, text]) => sanitizeStatus(text));
					if (statuses.length || doneIndicator) {
						const leftStatus = truncateToWidth(statuses.join(" "), width, theme.fg("dim", "…"));
						const rightStatus = doneIndicator ? sanitizeStatus(doneIndicator) : "";
						const availableRightStatus = Math.max(0, width - visibleWidth(leftStatus) - (leftStatus && rightStatus ? 1 : 0));
						const right = truncateToWidth(rightStatus, availableRightStatus, "");
						const padding = " ".repeat(Math.max(0, width - visibleWidth(leftStatus) - visibleWidth(right)));
						lines.push(`${leftStatus}${padding}${right}`);
					}

					return lines;
				},
			};
		});
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
	});
}
