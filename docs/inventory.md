# Machine Inventory

Use this file to map what actually exists on the machine.

## Components to identify

- Suna UI / worker
- Hermes review service
- Approval gate
- Log writers
- Artifact writers
- Playbook generator
- Any shell wrappers or helper scripts

## What to record

For each component, note:

- Path
- Process or command used to start it
- Output location
- Whether it is local, containerized, or remote
- Whether it is already wired into the control loop
- Any dependencies it needs

## Current state

The current scan found the following:

- Present: `services/suna`, `services/hermes`, `services/approval`, `logs/`, `artifacts/`, `playbooks/`
- Missing: `services/mobile-backend`, `infra/android-emulator`

The repo now contains the service homes for Suna, Hermes, and the approval gate, plus the shared storage folders. Mobile is deferred for now, so treat those placeholders as out of active scope until the core loop is working.