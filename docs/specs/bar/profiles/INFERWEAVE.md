# InferWeave Brownfield Profile
Prioritize distributed topology, scheduling, routing, admission, model residency and failure behavior. Validate the tree topology: local gateway -> Slurm gateway -> Slurm-managed RTX PRO 6000 workers. Treat GPUs as generic elastic workers and models as scheduled workloads. Validate subtree discovery endpoints, health/capacity/provider attribution, WAN-aware routing/session affinity, queueing, batching, scaling/draining, worker grouping and model hot-swap.

Failure injection must cover worker/gateway loss, model-load failure, queue pressure, caller concurrency 429, drain/release, multi-GPU allocation failure, remote-site slowness/unavailability, retries and client disconnects. Never fake unavailable live-GPU evidence.
