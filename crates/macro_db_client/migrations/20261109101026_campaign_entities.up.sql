-- Outreach campaigns. The campaign owns identity, sending policy and steps;
-- reusable database storage owns the recipient table (one row per contact),
-- exactly as CRM pipelines do.
CREATE TABLE campaign_entities (
    id UUID PRIMARY KEY,
    team_id UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    database_id UUID NOT NULL UNIQUE REFERENCES databases(id) ON DELETE RESTRICT,
    table_id UUID NOT NULL UNIQUE REFERENCES database_tables(id) ON DELETE RESTRICT,
    -- The protected contact reference column; every recipient is a CRM contact.
    primary_column_id UUID NOT NULL UNIQUE REFERENCES database_columns(id) DEFERRABLE INITIALLY DEFERRED,
    name TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
    -- IANA zone for the sending window when a recipient has no zone of their own.
    time_zone TEXT NOT NULL DEFAULT 'UTC',
    -- Optional recipient column holding each recipient's IANA zone.
    time_zone_column_id UUID REFERENCES database_columns(id) ON DELETE SET NULL,
    -- Local sending window, minutes after midnight, end exclusive.
    window_start_minute SMALLINT NOT NULL DEFAULT 540 CHECK (window_start_minute BETWEEN 0 AND 1439),
    window_end_minute SMALLINT NOT NULL DEFAULT 1020 CHECK (window_end_minute BETWEEN 1 AND 1440),
    -- ISO weekdays allowed, bit 0 = Monday. Default Monday to Friday.
    send_days SMALLINT NOT NULL DEFAULT 31 CHECK (send_days BETWEEN 1 AND 127),
    stop_on_reply BOOLEAN NOT NULL DEFAULT true,
    track_opens BOOLEAN NOT NULL DEFAULT true,
    -- The user's quoted approval, recorded when an agent launched the campaign.
    launch_confirmation TEXT,
    launched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    trashed_at TIMESTAMPTZ,
    CHECK (window_start_minute < window_end_minute)
);
CREATE INDEX campaign_entities_team ON campaign_entities(team_id);
CREATE INDEX campaign_entities_active ON campaign_entities(id) WHERE status = 'active' AND trashed_at IS NULL;

CREATE FUNCTION clean_up_campaign() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    DELETE FROM entity_access WHERE entity_id = OLD.id AND entity_type = 'campaign';
    DELETE FROM database_changes WHERE database_id = OLD.database_id;
    DELETE FROM databases WHERE id = OLD.database_id;
    RETURN NULL;
END $$;
CREATE TRIGGER campaign_cleanup AFTER DELETE ON campaign_entities
FOR EACH ROW EXECUTE FUNCTION clean_up_campaign();

-- A mailbox that is not a connected Gmail or Outlook inbox: SMTP (replies by
-- IMAP) or SendGrid. The secret is KMS ciphertext, as for `cursor_api_keys`.
CREATE TABLE campaign_sending_identities (
    id UUID PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE ON UPDATE CASCADE,
    transport TEXT NOT NULL CHECK (transport IN ('smtp', 'sendgrid')),
    from_email TEXT NOT NULL,
    from_name TEXT,
    -- SMTP submission and IMAP reply polling; unused for SendGrid.
    smtp_host TEXT,
    smtp_port INTEGER CHECK (smtp_port BETWEEN 1 AND 65535),
    imap_host TEXT,
    imap_port INTEGER CHECK (imap_port BETWEEN 1 AND 65535),
    username TEXT,
    -- SMTP/IMAP password or SendGrid API key.
    secret_ciphertext BYTEA NOT NULL,
    encryption_version SMALLINT NOT NULL,
    kms_key_id TEXT NOT NULL,
    -- IMAP reply cursor; a changed UIDVALIDITY restarts the scan.
    imap_uid_validity BIGINT,
    imap_last_uid BIGINT,
    verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, from_email),
    CHECK (transport <> 'smtp' OR (smtp_host IS NOT NULL AND smtp_port IS NOT NULL AND username IS NOT NULL))
);

-- Mailboxes a campaign rotates through, each with its own daily cap. A
-- connected inbox sends through email's durable send admission, so mail lands
-- in Sent and threads like any other message.
CREATE TABLE campaign_senders (
    campaign_id UUID NOT NULL REFERENCES campaign_entities(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL,
    link_id UUID REFERENCES email_links(id) ON DELETE CASCADE,
    identity_id UUID REFERENCES campaign_sending_identities(id) ON DELETE CASCADE,
    daily_cap INTEGER NOT NULL DEFAULT 50 CHECK (daily_cap BETWEEN 1 AND 2000),
    PRIMARY KEY (campaign_id, position),
    CHECK (num_nonnulls(link_id, identity_id) = 1)
);
CREATE UNIQUE INDEX campaign_senders_link ON campaign_senders(campaign_id, link_id) WHERE link_id IS NOT NULL;
CREATE UNIQUE INDEX campaign_senders_identity ON campaign_senders(campaign_id, identity_id) WHERE identity_id IS NOT NULL;

-- Ordered email steps. Step 1's delay counts from launch (or enrollment);
-- later delays count from the previous step's send.
CREATE TABLE campaign_steps (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaign_entities(id) ON DELETE CASCADE,
    position SMALLINT NOT NULL CHECK (position >= 1),
    delay_minutes INTEGER NOT NULL DEFAULT 0 CHECK (delay_minutes >= 0),
    -- Follow-ups reply in the first step's thread when the subject is empty.
    subject TEXT NOT NULL DEFAULT '',
    body_html TEXT NOT NULL DEFAULT '',
    body_text TEXT,
    body_macro TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT campaign_steps_position UNIQUE (campaign_id, position) DEFERRABLE INITIALLY IMMEDIATE
);

-- Per-recipient progress. One row per enrolled recipient row. Follow-ups
-- reuse the mailbox and thread of the recipient's first send.
CREATE TABLE campaign_recipients (
    campaign_id UUID NOT NULL REFERENCES campaign_entities(id) ON DELETE CASCADE,
    row_id UUID NOT NULL REFERENCES database_rows(id) ON DELETE CASCADE,
    -- Snapshot of the row's contact at enrollment, so sending never reads CRM.
    contact_id UUID,
    email TEXT NOT NULL,
    name TEXT,
    -- The row's IANA zone at enrollment; the campaign's zone when absent.
    time_zone TEXT,
    state TEXT NOT NULL DEFAULT 'active'
        CHECK (state IN ('active', 'completed', 'replied', 'bounced', 'unsubscribed', 'failed', 'removed')),
    next_position SMALLINT NOT NULL DEFAULT 1,
    next_send_at TIMESTAMPTZ,
    -- Consecutive transient failures of the next step; the sequence fails at 5.
    send_attempts SMALLINT NOT NULL DEFAULT 0,
    enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign_id, row_id)
);
CREATE INDEX campaign_recipients_due ON campaign_recipients(next_send_at) WHERE state = 'active';

-- One row per email a step sends. The row is reserved before the provider
-- call, so a crash or retry can never send the same step to the same
-- address twice.
CREATE TABLE campaign_sends (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES campaign_entities(id) ON DELETE CASCADE,
    step_id UUID NOT NULL REFERENCES campaign_steps(id) ON DELETE CASCADE,
    row_id UUID REFERENCES database_rows(id) ON DELETE SET NULL,
    recipient_email TEXT NOT NULL,
    link_id UUID REFERENCES email_links(id) ON DELETE SET NULL,
    identity_id UUID REFERENCES campaign_sending_identities(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN ('reserved', 'sent', 'failed', 'uncertain')),
    -- Email's message row for connected inboxes; no FK, mail may be deleted.
    email_message_id UUID,
    -- RFC 5322 Message-ID; threads follow-ups and matches replies.
    rfc_message_id TEXT,
    -- Rendered subject; follow-ups without their own reply as "Re: " it.
    subject TEXT,
    error TEXT,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    open_count INTEGER NOT NULL DEFAULT 0,
    replied_at TIMESTAMPTZ,
    bounced_at TIMESTAMPTZ,
    UNIQUE (campaign_id, step_id, recipient_email)
);
CREATE INDEX campaign_sends_campaign ON campaign_sends(campaign_id, reserved_at);
CREATE INDEX campaign_sends_link_day ON campaign_sends(link_id, reserved_at) WHERE link_id IS NOT NULL;
CREATE INDEX campaign_sends_identity_day ON campaign_sends(identity_id, reserved_at) WHERE identity_id IS NOT NULL;
CREATE INDEX campaign_sends_rfc_message_id ON campaign_sends(rfc_message_id) WHERE rfc_message_id IS NOT NULL;

-- Addresses a team never mails again: unsubscribes, hard bounces, manual.
-- Emails are stored lowercase.
CREATE TABLE campaign_suppressions (
    team_id UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    reason TEXT NOT NULL CHECK (reason IN ('unsubscribed', 'bounced', 'complained', 'manual')),
    campaign_id UUID REFERENCES campaign_entities(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (team_id, email)
);
