-- M7: migrated `svc:*` identities can never log in; retire them.
UPDATE users SET disabled_at = CAST(unixepoch('subsec') * 1000 AS INTEGER) WHERE username LIKE 'svc:%' AND disabled_at IS NULL;
