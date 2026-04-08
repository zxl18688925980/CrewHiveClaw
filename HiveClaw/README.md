# HiveClaw — Cloud Framework

> Part of the [CrewHiveClaw](../) architecture system.
> **Status: Placeholder — development starting ~2026-05**

---

## Overview

HiveClaw is the cloud counterpart to CrewClaw, enabling multi-organization deployment, cloud-hosted agents, and cross-instance coordination.

| Layer | CrewClaw (local) | HiveClaw (cloud) |
|-------|-----------------|-----------------|
| Runtime | Local machine (PM2 + OpenClaw Gateway) | Cloud-hosted containers |
| Agents | Embedded in Gateway | Cloud-native agent runtime |
| Memory | Local ChromaDB + Kuzu | Distributed persistent store |
| Channels | WeChat Work, local TTS/vision | Multi-channel cloud gateway |
| Scope | Single organization | Multi-organization / SaaS |

---

## Planned Directory Structure

```
hiveclaw/
  api/          ← Cloud API layer (agent routing, auth, webhooks)
  runtime/      ← Cloud agent runtime (containerized OpenClaw)
  storage/      ← Distributed memory / knowledge store adapters
  channels/     ← Cloud channel connectors
  infra/        ← IaC (Terraform / Docker Compose / K8s)
  docs/         ← HiveClaw design docs
```

---

## Relationship to CrewClaw

CrewClaw and HiveClaw share the same four-role organization model (Lucas / Andy / Lisa / Main) and plugin interface contract. A CrewClaw local instance can optionally sync with a HiveClaw cloud backend for:

- Remote memory persistence and cross-device continuity
- Cloud inference fallback when local models are unavailable
- Multi-org knowledge sharing and agent coordination
- Always-on channel availability (no local machine dependency)

---

*Design docs to be added when development starts.*
