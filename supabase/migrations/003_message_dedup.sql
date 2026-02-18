-- Add external_message_id for webhook deduplication
alter table conversations add column external_message_id text;
create index idx_conversations_external_msg on conversations (external_message_id) where external_message_id is not null;
