import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";

type WorkMode = "planner" | "builder";

interface WorkModeState {
	mode: WorkMode;
	toolsBeforePlanner?: string[];
}

const STATE_TYPE = "work-mode-state";
const STATUS_KEY = "work-mode";
const PLANNER_DISABLED_TOOLS = new Set(["bash", "powershell", "edit", "write"]);

export default function workModeExtension(pi: ExtensionAPI): void {
	let mode: WorkMode = "builder";
	let toolsBeforePlanner: string[] | undefined;

	pi.registerFlag("work-mode", {
		description: "Initial work mode: planner or builder",
		type: "string",
	});

	pi.events.on("work-mode:query", (data) => {
		if (data && typeof data === "object") (data as { mode?: WorkMode }).mode = mode;
	});

	function updateStatus(ctx: ExtensionContext): void {
		const label = `Mode: ${mode.toUpperCase()}`;
		const color = mode === "planner" ? "warning" : "accent";
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, label));
	}

	function enablePlannerTools(): void {
		if (!toolsBeforePlanner) toolsBeforePlanner = pi.getActiveTools();
		pi.setActiveTools(toolsBeforePlanner.filter((name) => !PLANNER_DISABLED_TOOLS.has(name)));
	}

	function enableBuilderTools(): void {
		if (toolsBeforePlanner) pi.setActiveTools(toolsBeforePlanner);
		toolsBeforePlanner = undefined;
	}

	function persistState(): void {
		pi.appendEntry<WorkModeState>(STATE_TYPE, { mode, toolsBeforePlanner });
	}

	function applyMode(nextMode: WorkMode, ctx: ExtensionContext, notify = true): void {
		mode = nextMode;
		if (mode === "planner") enablePlannerTools();
		else enableBuilderTools();

		updateStatus(ctx);
		persistState();

		if (notify) {
			ctx.ui.notify(
				mode === "planner"
					? "Planner mode enabled. Shell and built-in write tools are disabled."
					: "Builder mode enabled. Full tool access is restored.",
				"info",
			);
		}
	}

	async function chooseMode(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify(`Current mode: ${mode}`, "info");
			return;
		}

		const choice = await ctx.ui.select("Work mode", [
			"Planner — inspect and prepare a plan",
			"Builder — edit and execute",
		]);
		if (choice?.startsWith("Planner")) applyMode("planner", ctx);
		else if (choice?.startsWith("Builder")) applyMode("builder", ctx);
	}

	pi.registerCommand("mode", {
		description: "Show or switch between planner and builder mode",
		getArgumentCompletions: (prefix) =>
			["planner", "builder", "toggle", "status"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (!requested) {
				await chooseMode(ctx);
				return;
			}
			if (requested === "status") {
				ctx.ui.notify(`Current mode: ${mode}`, "info");
				return;
			}
			if (requested === "toggle") {
				applyMode(mode === "planner" ? "builder" : "planner", ctx);
				return;
			}
			if (requested === "planner" || requested === "builder") {
				applyMode(requested, ctx);
				return;
			}
			ctx.ui.notify("Usage: /mode [planner|builder|toggle|status]", "warning");
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle planner/builder mode",
		handler: (ctx) => applyMode(mode === "planner" ? "builder" : "planner", ctx),
	});

	pi.on("before_agent_start", async () => {
		if (mode !== "planner") return;
		return {
			message: {
				customType: "work-mode-planner-context",
				content: `[PLANNER MODE ACTIVE]\nInspect and reason about the task, ask clarifying questions when needed, and produce a concrete implementation plan. Do not modify implementation files, execute shell commands, or perform other side effects. The project_tasks tool is the sole permitted write mechanism; use it only to create or revise planning metadata in .pi/tasks.json. Do not claim, complete, or redefine in-progress tasks.`,
				display: false,
			},
		};
	});

	pi.on("context", async (event) => {
		if (mode === "planner") return;
		return {
			messages: event.messages.filter((message) => {
				const candidate = message as typeof message & { customType?: string };
				return candidate.customType !== "work-mode-planner-context";
			}),
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const configuredMode = pi.getFlag("work-mode");
		const hasConfiguredMode = configuredMode === "planner" || configuredMode === "builder";
		const stateEntry = ctx.sessionManager
			.getBranch()
			.filter(
				(entry): entry is typeof entry & { customType: string; data?: WorkModeState } =>
					entry.type === "custom" && entry.customType === STATE_TYPE,
			)
			.at(-1);

		if (!hasConfiguredMode && stateEntry?.data) {
			mode = stateEntry.data.mode;
			toolsBeforePlanner = stateEntry.data.toolsBeforePlanner;
		} else if (hasConfiguredMode) {
			mode = configuredMode;
			toolsBeforePlanner = undefined;
		}

		if (mode === "planner") enablePlannerTools();
		else enableBuilderTools();
		updateStatus(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
