-- M1 stored duplicate provider event ids; keep the earliest event of each
-- (source_id, provider_event_id) group so the 0004 UNIQUE index can be built.
-- IDs are ULIDs, so MIN(id) is the earliest. No rows are deleted.
UPDATE webhook_events SET provider_event_id = NULL
WHERE provider_event_id IS NOT NULL
  AND id NOT IN (
    SELECT MIN(id) FROM webhook_events
    WHERE provider_event_id IS NOT NULL
    GROUP BY source_id, provider_event_id
  );
