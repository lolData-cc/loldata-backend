-- supabase/migrations/scout_match_comments_threading.sql
--
-- Reddit-style threaded comments. parent_comment_id self-references
-- scout_match_comments so a reply can attach to a specific comment.
-- NULL parent → top-level reply to the match itself.
--
-- ON DELETE CASCADE: if the parent comment is removed (e.g. moderation,
-- account deletion via auth cleanup), the whole subtree goes with it.

ALTER TABLE scout_match_comments
  ADD COLUMN IF NOT EXISTS parent_comment_id UUID
    REFERENCES scout_match_comments(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_scout_match_comments_parent
  ON scout_match_comments (parent_comment_id);
