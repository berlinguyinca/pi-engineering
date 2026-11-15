---
name: pe-operator
description: How an operator drives Pi Engineering from the main session - when to use /engineer, /plan, /execute, /verify, /review and /ledger, and what evidence each one records. Use when asked how to run an engineering workflow with Pi Engineering.
metadata:
  version: 0.1.0
---

# Pi Engineering operator guide

This skill is operator guidance only. Pi Engineering worker sessions never load skills; they receive their instructions from the runtime. Do not paste this text into worker prompts.

## Commands

- `/engineer <goal>` runs the adaptive workflow: scout, implement, verify, review. Use it for a single goal.
- `/plan <goal>` decomposes a goal into a dependency-aware task DAG recorded in the ledger. It does not execute anything.
- `/execute [planId]` runs a planned DAG in dependency order; each task goes through the engineer pipeline. Without an id it uses the latest work item.
- `/verify [full]` runs risk-appropriate verification and records deterministic evidence. `full` adds the broader suite (lint plus full tests).
- `/review` launches a fresh-context independent review of the current work item's candidate. A candidate never approves itself.
- `/ledger` shows compact engineering state: work items, candidates, entities.

## Rules

1. Claims need evidence. A passing verify record or a cited command output counts; a comment, PR body or model assertion does not.
2. Work happens in your own git worktree. Never run checkout, switch or reset in a directory you do not own.
3. Integrate through a pull request from a feature branch. Never push to the default branch.
4. Do not run scripts that a third-party skill ships unless the operator approved them.
5. Skill auto-learn stays off. Lessons become durable only through the ledger or the configured memory backend, after review.
