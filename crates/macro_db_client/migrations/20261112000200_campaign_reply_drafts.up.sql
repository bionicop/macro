-- Replies can be drafted for the owner to review. Nothing here sends mail: a
-- draft is only ever text waiting for a person.
ALTER TABLE campaign_entities
    ADD COLUMN auto_draft_replies BOOLEAN NOT NULL DEFAULT false;

-- One row per inbound reply of an enrolled recipient, queued when the reply is
-- recorded on a campaign with auto_draft_replies. 'pending' waits for text,
-- 'ready' has text for review, 'dismissed' was set aside, 'sent' went out.
CREATE TABLE campaign_reply_drafts (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaign_entities(id) ON DELETE CASCADE,
    row_id UUID REFERENCES database_rows(id) ON DELETE SET NULL,
    recipient_email TEXT NOT NULL,
    -- The campaign email the recipient replied to.
    send_id UUID REFERENCES campaign_sends(id) ON DELETE SET NULL,
    -- The reply and its thread in email; no FKs, mail may be deleted.
    inbound_message_id UUID NOT NULL,
    thread_id UUID,
    inbound_subject TEXT,
    -- The start of the reply's text, for whoever writes the draft.
    inbound_text TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'ready', 'dismissed', 'sent')),
    draft_subject TEXT NOT NULL DEFAULT '',
    draft_body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A reply is queued once however many sends it answers.
    UNIQUE (campaign_id, inbound_message_id)
);
CREATE INDEX campaign_reply_drafts_campaign ON campaign_reply_drafts(campaign_id, created_at DESC);
CREATE INDEX campaign_reply_drafts_pending ON campaign_reply_drafts(created_at) WHERE status = 'pending';
