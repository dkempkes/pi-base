import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "zz-done-indicator";

type Outcome = "completed" | "aborted" | "error" | undefined;

function doneWavPath(): string {
	const file = path.join(os.tmpdir(), "pi-done-completed-chime.wav");
	if (fs.existsSync(file)) return file;

	const sampleRate = 44_100;
	const duration = 1.25;
	const samples = Math.floor(sampleRate * duration);
	const data = Buffer.alloc(samples * 2);
	const notes = [
		{ start: 0.00, length: 0.55, frequencies: [523.25, 659.25, 783.99], gain: 0.28 },
		{ start: 0.18, length: 0.62, frequencies: [659.25, 783.99, 1046.5], gain: 0.24 },
		{ start: 0.42, length: 0.78, frequencies: [783.99, 987.77, 1318.51], gain: 0.22 },
	];

	for (let i = 0; i < samples; i++) {
		const t = i / sampleRate;
		let value = 0;
		for (const note of notes) {
			const local = t - note.start;
			if (local < 0 || local > note.length) continue;
			const attack = Math.min(1, local / 0.025);
			const decay = Math.exp(-3.2 * local / note.length);
			const fade = Math.min(1, (note.length - local) / 0.12);
			const envelope = attack * decay * fade * note.gain;
			for (const frequency of note.frequencies) {
				value += Math.sin(2 * Math.PI * frequency * local) * envelope / note.frequencies.length;
				value += Math.sin(2 * Math.PI * frequency * 2 * local) * envelope * 0.08 / note.frequencies.length;
			}
		}
		const shaped = Math.tanh(value * 1.6);
		data.writeInt16LE(Math.max(-1, Math.min(1, shaped)) * 32767, i * 2);
	}

	const header = Buffer.alloc(44);
	header.write("RIFF", 0);
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36);
	header.writeUInt32LE(data.length, 40);
	fs.writeFileSync(file, Buffer.concat([header, data]));
	return file;
}

async function playDoneSound(): Promise<void> {
	if (process.platform === "win32") {
		const wav = doneWavPath().replace(/'/g, "''");
		await new Promise<void>((resolve, reject) => {
			const child = spawn(
				"powershell.exe",
				["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; $player = New-Object Media.SoundPlayer '${wav}'; try { $player.Load(); $player.PlaySync() } finally { $player.Dispose() }`],
				{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
			);
			let stderr = "";
			child.stderr?.on("data", (data) => { stderr = (stderr + data.toString()).slice(-4000); });
			child.once("error", reject);
			child.once("close", (code) => {
				if (code === 0) resolve();
				else reject(new Error(stderr.trim() || `Sound playback exited with code ${code}`));
			});
		});
		return;
	}

	// Fallback for non-Windows terminals with bell enabled.
	process.stdout.write("\u0007\u0007");
}

function setDoneStatus(ctx: ExtensionContext, visible: boolean): void {
	ctx.ui.setStatus(
		STATUS_KEY,
		visible ? ctx.ui.theme.fg("success", ctx.ui.theme.bold("DONE")) : undefined,
	);
}

export default function doneSoundExtension(pi: ExtensionAPI): void {
	let lastOutcome: Outcome;

	async function notifyDone(ctx: ExtensionContext): Promise<void> {
		try {
			await playDoneSound();
		} catch (error) {
			ctx.ui.notify(`DONE-geluid kon niet worden afgespeeld: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	pi.registerCommand("done-sound", {
		description: "Test het geluid voor een afgeronde agent-run",
		handler: async (_args, ctx) => {
			await notifyDone(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setDoneStatus(ctx, false);
	});

	pi.on("agent_start", async (_event, ctx) => {
		lastOutcome = undefined;
		setDoneStatus(ctx, false);
	});

	pi.on("agent_before_settle", async (event) => {
		lastOutcome = event.outcome;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (lastOutcome !== "completed") return;
		setDoneStatus(ctx, true);
		await notifyDone(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		setDoneStatus(ctx, false);
	});
}
