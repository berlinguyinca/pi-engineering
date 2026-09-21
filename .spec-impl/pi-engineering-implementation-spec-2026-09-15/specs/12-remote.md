# 12 Remote workers
Local/remote implement one Worker contract. Remote hosts connect outbound with authenticated channels; no public inbound requirement. Preserve IDs, permissions, OpenViking, events, cancellation and worktree semantics. Make commands idempotent and recover from disconnects. Location/latency are placement attributes, not a second orchestration API.
