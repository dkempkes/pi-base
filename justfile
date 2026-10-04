# Just command runner recipes for this Pi workspace
# Usage: just <recipe>

# On Windows, avoid requiring a POSIX shell on PATH.
set windows-shell := ["cmd.exe", "/C"]

l_sesn := "--session-dir .pi/session-data"
builder_model := "gpt-5.6-sol:medium"
planner_model := "gpt-5.6-sol:high"
project_instructions := ".pi/APPEND_SYSTEM.md"
planner_instructions := "Act as a read-only implementation planner. Inspect the repository thoroughly, ask clarifying questions when needed, and produce a concrete numbered implementation plan. Do not modify files or claim to have implemented the plan."

# Show available recipes
default:
    just --list

# Ensure local Pi workspace directories exist
init:
    if not exist .pi\session-data mkdir .pi\session-data
    if not exist .pi\extensions mkdir .pi\extensions
    if not exist .pi\skills mkdir .pi\skills
    if not exist .pi\prompts mkdir .pi\prompts
    if not exist .pi\themes mkdir .pi\themes
    if not exist docs mkdir docs

# Start Pi in this workspace and save sessions under .pi/session-data
pi *args:
    pi {{l_sesn}} --approve --append-system-prompt {{project_instructions}} {{args}}

# Continue the most recent session for this workspace
continue:
    pi {{l_sesn}} --approve --append-system-prompt {{project_instructions}} --continue

# Open the session picker for this workspace
resume:
    pi {{l_sesn}} --approve --append-system-prompt {{project_instructions}} --resume

# Start a named session: just named "extension idea"
named name *args:
    pi {{l_sesn}} --approve --append-system-prompt {{project_instructions}} --name "{{name}}" {{args}}

# Builder agent using GPT-5.6 Sol with medium reasoning and Pi-project knowledge
builder *args:
    pi {{l_sesn}} --approve --work-mode builder --provider openai-codex --model {{builder_model}} --append-system-prompt {{project_instructions}} {{args}}

# Read-only planner using GPT-5.6 Sol with high reasoning and Pi-project knowledge
planner *args:
    pi {{l_sesn}} --approve --work-mode planner --provider openai-codex --model {{planner_model}} --tools read,grep,find,ls --append-system-prompt {{project_instructions}} --append-system-prompt "{{planner_instructions}}" {{args}}

# List saved session files, newest first
sessions:
    dir /B /O-D .pi\session-data\*.jsonl
