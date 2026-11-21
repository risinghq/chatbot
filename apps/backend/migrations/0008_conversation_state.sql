-- The sales assistant reads the messages, not a stored phase, so a
-- conversation keeps only who it is with, who answers it and when it was last
-- active. The customer is the `customers` row with the same phone number.
--
-- The columns are dropped in place. Rebuilding the table would delete the
-- messages, alerts and outbox rows that cascade from it.

-- `current_state` is generated from `context_data`, so it goes first.
ALTER TABLE conversations DROP COLUMN current_state;
ALTER TABLE conversations DROP COLUMN context_data;
ALTER TABLE conversations DROP COLUMN client_name;
ALTER TABLE conversations DROP COLUMN dni;
ALTER TABLE conversations DROP COLUMN is_calidda_client;
ALTER TABLE conversations DROP COLUMN segment;
ALTER TABLE conversations DROP COLUMN credit_line;
ALTER TABLE conversations DROP COLUMN nse;
ALTER TABLE conversations DROP COLUMN age;
ALTER TABLE conversations DROP COLUMN persona_id;
ALTER TABLE conversations DROP COLUMN products_interested;
ALTER TABLE conversations DROP COLUMN delivery_address;
ALTER TABLE conversations DROP COLUMN delivery_reference;
ALTER TABLE conversations DROP COLUMN agent_notes;
ALTER TABLE conversations DROP COLUMN sale_status;
ALTER TABLE conversations DROP COLUMN recording_contract_asset_id;
ALTER TABLE conversations DROP COLUMN recording_audio_asset_id;
ALTER TABLE conversations DROP COLUMN recording_uploaded_at;

-- Nothing has written a phase to an LLM call since the assistant stopped
-- tracking one.
ALTER TABLE llm_calls DROP COLUMN conversation_phase;

-- The phase machine was the only writer of analytics events.
DROP TABLE analytics_events;

DROP TABLE test_personas;
