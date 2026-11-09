-- Preserve recipient tables as ordinary database app entities on rollback,
-- as the CRM pipeline rollback does.
INSERT INTO database_entities (database_id, name, user_id, created_at, updated_at, trashed_at)
SELECT database_id, name, user_id, created_at, updated_at, trashed_at FROM campaign_entities
ON CONFLICT DO NOTHING;
INSERT INTO entity_access (entity_id, entity_type, source_id, source_type, access_level)
SELECT c.database_id, 'database', ea.source_id, ea.source_type, ea.access_level
FROM campaign_entities c JOIN entity_access ea ON ea.entity_id = c.id AND ea.entity_type = 'campaign'
ON CONFLICT DO NOTHING;
DELETE FROM entity_access WHERE entity_type = 'campaign' AND entity_id IN (SELECT id FROM campaign_entities);
DROP TABLE campaign_suppressions;
DROP TABLE campaign_sends;
DROP TABLE campaign_recipients;
DROP TABLE campaign_steps;
DROP TABLE campaign_senders;
DROP TABLE campaign_sending_identities;
DROP TRIGGER campaign_cleanup ON campaign_entities;
DELETE FROM database_column_protections WHERE column_id IN (SELECT primary_column_id FROM campaign_entities);
DROP TABLE campaign_entities;
DROP FUNCTION clean_up_campaign();
