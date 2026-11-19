// Default content for a new room's knowledge base. Agent-facing docs are in English on purpose:
// every coding agent follows English instructions most reliably. Humans can edit everything.

export const DEFAULT_DOCS: Record<string, string> = {
  "/team/requirements.md": `# Requirements

<!-- Humans: describe the product here. What are we building, for whom, which features are MUST / NICE TO HAVE, demo scenario for the jury. -->

## Goal

## Must have

## Nice to have

## Demo scenario
`,
  "/team/architecture.md": `# Architecture

<!-- Humans: stack, repo layout, how parts talk to each other. Agents rely on this. -->

## Stack
- Frontend:
- Backend:
- Database:

## Repository layout
- \`/frontend\` — owned by the frontend agent
- \`/backend\` — owned by the backend agent

## Conventions
- API contract lives in \`/generated/api-contract.md\` (written by agents, source of truth for frontend ↔ backend).
`,
  "/team/workflow.md": `# How we work together (team protocol)

Several people work on this project, each with their own AI coding agent. All agents are connected
to the same room through the \`room\` MCP server. **The room is the single source of truth** for the plan,
who does what, and every important decision.

## 1. Always start with context
- Call \`get_context\` at the start of every session and after every finished task.
  It returns only what changed since your last call, plus anything you still must acknowledge.
- Read your own profile in \`/agents/<you>/profile.md\` — it defines your role and your area.

## 2. Plan together, then execute
The room goes through phases: \`setup → planning → plan_review → executing → done\`.
- **planning**: the lead agent drafts the overall plan (\`propose_plan\`): goal, milestones, one workstream per agent.
  Every agent then writes a **subplan** for its own workstream (\`propose_subplan\`): concrete tasks with
  acceptance criteria, files/paths, dependencies (including on other agents' tasks) and subtasks.
  Discuss in the \`general\` channel, comment with \`comment_plan\`. The lead submits for human review.
- **executing**: work strictly by the approved plan. Need to change it? \`propose_plan_change\` — humans approve.

## 3. Tasks
- \`claim_task\` before writing any code for it. You cannot claim a task whose dependencies are not done.
- Keep your subtasks up to date (\`check_subtask\`) so humans see progress.
- \`set_status\` when you start something new (one line, what and where).
- Finish: open a PR, \`link_pr\`, \`update_task status=review\` with a note. It becomes \`done\` automatically when the PR is merged.

## 4. Stay in your lane
- Only edit files inside your area (paths in your profile / task paths). Claimed paths are soft locks — respect other agents' claims.
- Need a change in another agent's area? \`send_message\` to that agent or \`create_task\` assigned to them. Never edit their files.

## 5. What goes into the ledger (general context) — and what does NOT
The ledger is the shared memory **every** agent must know. Use \`publish\` ONLY for:
- \`decision\` — architectural or product decisions (library choice, data model, auth approach)
- \`api_change\` — any change to the API contract, shared types, events (update \`/generated/api-contract.md\` first)
- \`env_change\` — new env vars, services, ports, scripts, dependencies others need
- \`blocker\` — you are blocked and someone else must act
- \`handoff\` — work that another agent should continue
- \`milestone\` — a milestone is done / demo-able

Do NOT publish small, local things (button color, refactoring inside your own module, typo fixes).
Those go into task notes. When an entry concerns specific agents, set \`affects\` to their names.
**Always \`ack\` ledger entries that \`get_context\` shows you**, after you adapted your work.

## 6. Communication
- \`general\` channel — coordination that concerns everybody. Mention \`@name\` to get someone's attention.
- Direct messages — questions for one agent. Use \`wait_for_messages\` when you need the answer to continue.
- Task channels (\`task:<n>\`) — discussion about one task.
Be concrete: endpoints, field names, file paths, commands.

## 7. Git
- Branch per task: \`room/<task-number>-<short-slug>\` (e.g. \`room/12-login-form\`).
- Commit messages: \`#<task-number> <what changed>\`. Small, frequent commits.
- PR title: \`#<n> <task title>\`, PR body contains \`Task: #<n>\`, what changed, how to test.
- Never push to the default branch directly. Humans review and merge.
- If CI fails or a reviewer requests changes, you will get a message: call \`get_pr_feedback\` and fix.

## 8. Tests
- Every task includes tests for its acceptance criteria where reasonable.
- Run the test suite of your area before opening a PR.

## 9. Subagents
- You may use subagents (e.g. test writer, reviewer) to save your context. Templates: \`get_subagent_templates\`.
- Subagents do NOT talk to the room. You (the parent agent) report their results.
`,
  "/team/subagents/test-writer.md": `---
name: test-writer
description: Writes and runs tests for code that was just changed. Use after implementing a task, before opening a PR.
---

You are a test engineer. Given the files changed for the current task and its acceptance criteria:
1. Find the existing test setup and conventions of this area of the repository.
2. Write focused tests that cover each acceptance criterion and the main edge cases.
3. Run the tests and fix the tests (not the implementation) if they are wrong. If the implementation is wrong, report exactly what fails.
Return: list of test files, what they cover, and the test run result.
`,
  "/team/subagents/reviewer.md": `---
name: reviewer
description: Reviews a diff before a PR is opened. Use to catch bugs, missing edge cases and contract violations.
---

You are a strict code reviewer. Review the current diff against:
- the task's acceptance criteria,
- \`/generated/api-contract.md\` (read it through the parent agent's context),
- the conventions in the repository.
Report only real problems, ordered by severity, each with file:line and a concrete fix. No style nitpicks.
`,
  "/generated/api-contract.md": `# API contract

<!-- Maintained by agents. Every change here must also be published to the ledger as api_change. -->
`,
};

export const profileTemplate = (name: string, agentType: string, role: string, owner: string, paths: string[]) => `# ${name}

- **Agent:** ${agentType}
- **Run by:** ${owner}
- **Role:** ${role || "(describe the role)"}
- **Area (paths I own):** ${paths.length ? paths.map((p) => `\`${p}\``).join(", ") : "(set paths)"}

## Responsibilities
<!-- Owner: what this agent is responsible for, what it must NOT touch. -->

## How this agent should work
<!-- Owner: style, libraries, testing expectations, anything specific. -->
`;

// Short file committed to the repo: the real instructions live in the room and are always fresh.
export const pointerFile = (roomName: string) => `# Team room

This project is built by a team of AI agents coordinated through the room **"${roomName}"**
(MCP server \`room\`). All instructions, the plan, tasks and shared decisions live there.

**At the start of every session call the \`get_context\` tool of the \`room\` MCP server and follow it.**
Re-read it after finishing each task. Follow \`/team/workflow.md\` from the room.
`;

export const cursorPointer = (roomName: string) => `---
description: Team room protocol — always load context from the room MCP server
alwaysApply: true
---

${pointerFile(roomName)}`;
