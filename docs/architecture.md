# Architecture

## Product target

This is a branded AI automation product: ChatGPT-style conversation, Manus-style task execution, local Suna/Hermes orchestration, sandboxed tools, and subscription tiers similar to ChatGPT or Manus.

It is not only a VS Code assistant. Code work is one workflow, but the same agent surface should also handle spreadsheets, documents, files, browser tasks, research, and repeatable business automations.

## Core loop

1. You give Suna a real task.
2. Suna chooses the best tool path: files, shell, browser, spreadsheets, documents, APIs, or playbooks.
3. The approval system blocks risky actions until you explicitly approve them.
4. Results, logs, and artifacts are saved locally.
5. If Suna fails, self-flags, or gets reported for hallucination, the failure counter changes.
6. At 3 Suna failure signals, Hermes reviews the run and takes over or recommends what should become a playbook.

## Retry rule

Suna and Hermes are upstream open-source codebases that this platform is meant to run or integrate locally, not remote public workers.

Suna failure signals can come from two places:

- Suna self-detects unreliable output, an incomplete task, or a tool failure.
- The user flags Suna for hallucination.

Each active chat keeps a Suna failure counter. At 3 failure signals, the case escalates to Hermes for review/takeover instead of looping forever. A successful Suna response clears the counter for that chat.

## Responsibilities

### Suna

Suna is the primary worker. It should not be treated as the reviewer or the logger. Its job is to decide how to execute the task and use the right tool for the job, including code, Excel/CSV workflows, browser automation, documents, local files, and reusable playbooks. In this workspace, Suna maps to the local source checkout at `services/suna` and the upstream repo at https://github.com/kortix-ai/suna.

### Hermes

Hermes is a post-run reviewer. It looks at the evidence after execution and answers questions like: In this workspace, Hermes maps to the local source checkout at `services/hermes` and the upstream repo at https://github.com/NousResearch/hermes-agent.

Hermes answers questions like:

- What worked?
- What failed?
- What should be retried differently?
- What is reusable as a playbook?

## Model backend

The planned local brain is Ollama. Suna and Hermes are open-source orchestration layers, while Ollama supplies the LLM model runtime.

Use Ollama's OpenAI-compatible endpoint:

- `SUNA_BASE_URL=http://127.0.0.1:11434/v1`
- `HERMES_BASE_URL=http://127.0.0.1:11434/v1`
- `SUNA_MODEL=llama3.1`
- `HERMES_MODEL=llama3.1`

The specific model can change later, but the app should keep Suna and Hermes configurable as separate workers.

### Mobile backend and emulator

The mobile path is currently deferred. The workspace keeps placeholders for it, but the active buildout is focused on the non-mobile control plane first.

### Approval system

Safe actions can run automatically. Risky actions should pause and request approval. Typical risky categories include sending messages, posting publicly, purchases, deletions, account settings, billing changes, and business data edits.

## Local storage

- `logs/` keeps execution records.
- `artifacts/` keeps outputs and evidence.
- `playbooks/` keeps workflows that are worth reusing.

## Product plans

The subscription tiers are product packaging, not local trust boundaries. They should control quotas, team features, audit exports, and advanced integrations, while the local sandbox and approval policy remain safety requirements across all plans.

## Next implementation step

The next practical move is to wire Suna, Hermes, approval handling, and log/artifact flow before bringing mobile back into scope.
