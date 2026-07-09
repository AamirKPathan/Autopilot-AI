# Local Manus-Style AI Operating System

This workspace is the control plane for a branded AI automation product: ChatGPT-style chat, Manus-style task execution, Suna as the primary worker, Hermes as the escalation/review layer, and Ollama as the local model backend.

The goal is broader than VS Code. Code tasks are supported, but the platform is meant to automate spreadsheets, documents, files, browser work, research, reporting, and repeatable business workflows through sandboxed execution.

## Roles

- Suna: primary worker that executes tasks through tools.
- Suna: primary local worker inside your private AI environment.
- Hermes: post-task reviewer that analyzes logs, outcomes, and reusable playbooks.
- Groq: recommended hosted free-tier API used as the current localhost brain for Suna and Hermes.
- Mobile backend and Android emulator: deferred for now.
- Approval system: gates risky actions before execution.
- Logs and artifacts: capture task history, outputs, and evidence.

## Canonical layout

- `config/`: machine map and runtime configuration.
- `docs/`: architecture, workflows, and operating notes.
- `services/`: local homes for Suna, Hermes, and approval policy.
- `scripts/`: command entrypoints for start, stop, status, and mobile actions.
- `playbooks/`: reusable workflows promoted from successful runs.
- `logs/`: task and review logs.
- `artifacts/`: files produced during execution.

## Commands

- `scripts/bootstrap.ps1`: populate the local Suna and Hermes service homes from their upstream repos.
- `scripts/inventory.ps1`: report which configured components are present on disk.
- `scripts/start.ps1`: inspect and start the configured stack.
- `scripts/stop.ps1`: stop configured services.
- `scripts/status.ps1`: report component state.
- `scripts/mobile-start.ps1`: start the mobile backend or emulator side of the stack.
- `scripts/mobile-view.ps1`: open or attach to the mobile view workflow.
- `scripts/mobile-stop.ps1`: stop the mobile stack.

Mobile entrypoints remain in the scaffold, but they are not part of the active workstream right now.

## Frontend

This repo now includes the first pass of the branded control-room UI. It is a ChatGPT-style shell with:

- multiple chats in the left rail
- four chat types: General, Task, Research, and Build
- a Suna task composer
- a linked local AI endpoint with fallback behavior when no model server is configured
- a top-right `Report hallucination` action
- a top-right `Report bug` action
- a built-in subscription panel
- a per-chat Suna failure counter
- Hermes escalation after 3 Suna failure signals
- a local report modal that stores submissions in browser storage

Run it with:

```bash
npm install
npm run dev
```

For the current localhost setup, use Groq:

1. Create a Groq API key.
2. Paste it into `.env` as `GROQ_API_KEY=...`.
3. Run `npm run dev`.

The default `.env.example` values point Suna and Hermes at:

```bash
https://api.groq.com/openai/v1
```

If the key is missing, the UI shows `needs key` instead of pretending the weak local fallback is the real assistant.

## AI backends

The platform now treats Suna and Hermes as separate open-source codebases instead of a generic single-model backend.

- `SUNA_REPO_URL` should point at the Suna source repo: `https://github.com/kortix-ai/suna`
- `HERMES_REPO_URL` should point at the Hermes source repo: `https://github.com/NousResearch/hermes-agent`
- `SUNA_LOCAL_PATH` and `HERMES_LOCAL_PATH` name the local clone locations inside this workspace.
- The optional `SUNA_BASE_URL` / `HERMES_BASE_URL` settings are only for later if you wrap the repos in local services.
- The chat UI posts tasks to `POST /api/task`, which first tries Suna and escalates to Hermes after retries or corrections.
- Suna can self-flag unreliable output with `SUNA_SELF_FLAG: failure`.
- User hallucination reports also increment Suna's failure counter.
- At 3 failure signals, Hermes reviews/takes over and the chat counter resets.

This repo is intentionally a scaffold first: the command scripts are meant to make the current machine understandable before the actual services are wired in.

Task rule: Suna is the default worker. If Suna fails, self-flags, or is reported for hallucination 3 times in a chat, Hermes takes over.
