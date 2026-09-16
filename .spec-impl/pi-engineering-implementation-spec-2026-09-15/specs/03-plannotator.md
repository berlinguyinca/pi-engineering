# 03 Plannotator
Dockerized plan-review service. Persist PlanArtifact(run, version, content, status, annotations, actor, timestamps). Modes: interactive/autonomous/policy/disabled. Interactive blocks until decision; autonomous records policy bypass and continues; policy gates risk classes. Recover pending decisions after restart. Plannotator never launches workers.
