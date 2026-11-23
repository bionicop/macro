-- A step can be skipped for a recipient depending on whether they opened any
-- earlier email of the sequence when the step comes due.
ALTER TABLE campaign_steps
    ADD COLUMN send_condition TEXT NOT NULL DEFAULT 'always'
        CHECK (send_condition IN ('always', 'not_opened', 'opened'));
