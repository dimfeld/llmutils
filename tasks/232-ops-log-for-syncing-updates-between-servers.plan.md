---
# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json
title: ops log for syncing updates between servers
goal: ""
id: 232
uuid: d8a6e9a4-4754-4f1a-9065-0eeb7a5db0b7
status: pending
priority: medium
createdAt: 2026-03-17T09:10:34.648Z
updatedAt: 2026-03-17T09:17:29.440Z
tasks: []
tags: []
---

An ops log that uses a hybrid clock for syncing with last-write-wins semantics. Every operation that updates a plan or
workspace should be represented as an op that can be applied to the database.

We will probably also need to update the various row IDs to use UUIDs instead of integers, to avoid conflicts when
different servers create rows.

This work may be done before there are actually multiple servers syncing between each other, but this lays the
groundwork for that.

We should compact the ops log periodically by just deleting ops older than a certain threshold. Given the typical usage
patterns, retaining one month of ops is more than enough. We can also compact by removing fully superseded ops (e.g. an op
that only updates a plan's details means that any earlier ops that also only update the plan's details can be safely removed.)
