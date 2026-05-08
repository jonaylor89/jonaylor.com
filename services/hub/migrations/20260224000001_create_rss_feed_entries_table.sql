CREATE TABLE rss_feed_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    guid TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TIMESTAMPTZ,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    newsletter_issue_id uuid REFERENCES newsletter_issues(newsletter_issue_id)
);
