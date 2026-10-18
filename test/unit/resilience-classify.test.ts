import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATEGORY_TO_STATE, classifyInfraError, classifyStorageIncident } from "../../src/resilience/classify.ts";

describe("classifyInfraError", () => {
  it("classifies 503 / no worker as transient infrastructure", () => {
    const cls = classifyInfraError(new Error("503 no worker for model"));
    assert.equal(cls.category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(cls.retryable, true);
  });

  it("classifies network/timeout failures as transient infrastructure", () => {
    assert.equal(classifyInfraError(new Error("ECONNRESET")).category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(classifyInfraError(new Error("request timed out")).category, "TRANSIENT_INFRASTRUCTURE");
  });

  it("classifies model relocation as transient infrastructure with scheduler state", () => {
    const err: Record<string, unknown> = {
      message: "MODEL_RELOCATING",
      scheduler_state: "relocating",
      retryable: true,
      retry_after_ms: 15000,
      request_id: "req-1",
    };
    const cls = classifyInfraError(err);
    assert.equal(cls.category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(cls.scheduler_state, "relocating");
    assert.equal(cls.request_id, "req-1");
    assert.equal(cls.retryAfterMs, 15_000);
  });

  it("classifies 429 caller_concurrency as rate-limited", () => {
    const err: Record<string, unknown> = { status: 429, message: "inference admission: caller_concurrency" };
    const cls = classifyInfraError(err);
    assert.equal(cls.category, "RATE_LIMITED");
  });

  it("honours retry-after hints", () => {
    const cls = classifyInfraError({ status: 503, retryAfter: 30 });
    assert.equal(cls.retryAfterMs, 30_000);
  });

  it("classifies 413 / context overflow as context-recoverable, not infra", () => {
    const cls = classifyInfraError(new Error("413 request too large: context length exceeded"));
    assert.equal(cls.category, "CONTEXT_RECOVERABLE");
    assert.equal(CATEGORY_TO_STATE.CONTEXT_RECOVERABLE, "RECOVERING_CONTEXT");
  });

  it("classifies ENOSPC / disk-full as transient infrastructure and retryable", () => {
    const byCode = Object.assign(new Error("write"), { code: "ENOSPC" });
    const cls = classifyInfraError(byCode);
    assert.equal(cls.category, "TRANSIENT_INFRASTRUCTURE");
    assert.equal(cls.retryable, true);
    assert.equal(cls.reason, "storage / disk space");
    // Message-based match for a plain Error without an errno code.
    assert.equal(classifyInfraError(new Error("no space left on device")).category, "TRANSIENT_INFRASTRUCTURE");
    // Other storage errno codes are treated the same way (recoverable).
    assert.equal(classifyInfraError(Object.assign(new Error("x"), { code: "ENOMEM" })).retryable, true);
    assert.equal(
      classifyInfraError(Object.assign(new Error("x"), { code: "EIO" })).category,
      "TRANSIENT_INFRASTRUCTURE",
    );
    // A storage error must never be treated as a permanent/terminal failure.
    assert.notEqual(cls.category, "INVALID_REQUEST");
    assert.notEqual(cls.category, "AUTH_CONFIG");
  });

  it("classifies auth/config errors as needs attention and non-retryable", () => {
    const cls = classifyInfraError(new Error("401 invalid API key"));
    assert.equal(cls.category, "AUTH_CONFIG");
    assert.equal(cls.retryable, false);
    assert.equal(CATEGORY_TO_STATE.AUTH_CONFIG, "NEEDS_ATTENTION");
  });

  it("classifies invalid requests as needs attention and non-retryable", () => {
    const cls = classifyInfraError(new Error("400 unknown model gpt-4-nonexistent"));
    assert.equal(cls.category, "INVALID_REQUEST");
    assert.equal(cls.retryable, false);
  });

  it("maps each category to the correct mission state", () => {
    assert.equal(CATEGORY_TO_STATE.TRANSIENT_INFRASTRUCTURE, "WAITING_FOR_LLM");
    assert.equal(CATEGORY_TO_STATE.RATE_LIMITED, "WAITING_FOR_CAPACITY");
    assert.equal(CATEGORY_TO_STATE.CONTEXT_RECOVERABLE, "RECOVERING_CONTEXT");
    assert.equal(CATEGORY_TO_STATE.AUTH_CONFIG, "NEEDS_ATTENTION");
    assert.equal(CATEGORY_TO_STATE.INVALID_REQUEST, "NEEDS_ATTENTION");
  });
});

describe("classifyStorageIncident", () => {
  it("classifies plain ENOSPC as disk-full and auto-recoverable", () => {
    const err = Object.assign(new Error("write"), { code: "ENOSPC", path: "/data/out" });
    const inc = classifyStorageIncident(err);
    assert.equal(inc.category, "DISK_FULL");
    assert.equal(inc.recovery, "AUTO");
    assert.equal(inc.autoRecover, true);
    assert.equal(inc.needsOperator, false);
    assert.equal(inc.code, "ENOSPC");
    assert.equal(inc.path, "/data/out");
  });

  it("distinguishes inode exhaustion when bytes are plentiful", () => {
    const err = Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    const inc = classifyStorageIncident(err, { freeBytes: 1_000_000, freeInodes: 0 });
    assert.equal(inc.category, "INODE_EXHAUSTED");
    assert.equal(inc.autoRecover, true);
    assert.equal(inc.needsOperator, false);
  });

  it("treats EDQUOT as an auto-recoverable quota condition", () => {
    const err = Object.assign(new Error("quota exceeded"), { code: "EDQUOT" });
    const inc = classifyStorageIncident(err);
    assert.equal(inc.category, "QUOTA_EXCEEDED");
    assert.equal(inc.recovery, "AUTO");
    assert.equal(inc.autoRecover, true);
  });

  it("flags EROFS as an operator action, never blind auto-retry", () => {
    const err = Object.assign(new Error("write"), { code: "EROFS" });
    const inc = classifyStorageIncident(err);
    assert.equal(inc.category, "READ_ONLY_FS");
    assert.equal(inc.recovery, "OPERATOR");
    assert.equal(inc.autoRecover, false);
    assert.equal(inc.needsOperator, true);
  });

  it("treats EACCES as an operator action", () => {
    const err = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const inc = classifyStorageIncident(err);
    assert.equal(inc.needsOperator, true);
    assert.equal(inc.autoRecover, false);
  });

  it("treats EIO conservatively but probe-recoverable", () => {
    const err = Object.assign(new Error("input/output error"), { code: "EIO" });
    const inc = classifyStorageIncident(err);
    assert.equal(inc.category, "IO_ERROR");
    assert.equal(inc.recovery, "CONSERVATIVE");
    assert.equal(inc.autoRecover, true);
  });

  it("treats ENOTDIR as an operator action, not auto-recoverable disk pressure", () => {
    // "path is not a directory" is a path-shape/layout error (e.g. the work
    // dir was replaced by a file), not a storage-pressure condition. A disk
    // space probe can never clear it, so it must not suspend the mission.
    const err = Object.assign(new Error("ENOTDIR: not a directory, open '/x/.pi-eng/snapshot.json'"), {
      code: "ENOTDIR",
    });
    const inc = classifyStorageIncident(err);
    assert.equal(inc.autoRecover, false);
    assert.equal(inc.needsOperator, true);
    assert.equal(inc.recovery, "OPERATOR");
  });

  it("never classifies a healthy path as a storage failure without evidence", () => {
    const inc = classifyStorageIncident(new Error("boom"));
    assert.equal(inc.autoRecover, false);
    assert.equal(inc.needsOperator, true);
    assert.equal(inc.category, "UNKNOWN_STORAGE");
  });
});
