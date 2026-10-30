import { createHash } from "node:crypto";
import type { TableDef } from "./bridge.ts";

/**
 * The Google Sheet layout: one tab per table, row 1 holds the column names. Columns are matched by name, so the owner
 * may reorder them or add notes columns of their own. Every cell is text: timestamps are UTC ISO strings, lists are
 * JSON, booleans are "true" / "false", and an empty cell means "not set".
 */
export const TABLES = {
  settings: { name: "settings", columns: ["key", "enabled", "reason", "updated_by", "updated_at"], appendOnly: false },
  sources: {
    name: "sources",
    columns: [
      "id",
      "name",
      "kind",
      "url",
      "trust_tier",
      "erode_specific",
      "terms_status",
      "terms_reviewed_by",
      "terms_reviewed_at",
      "terms_notes",
      "allowed_use",
      "llm_input_allowed",
      "link_pattern",
      "fetch_interval_minutes",
      "enabled",
      "etag",
      "last_modified",
      "last_fetched_at",
      "consecutive_failures",
      "updated_at",
    ],
    appendOnly: false,
  },
  sourceItems: {
    name: "source_items",
    columns: [
      "id",
      "source_id",
      "canonical_url",
      "url_hash",
      "title",
      "excerpt",
      "language",
      "published_at",
      "fetched_at",
      "content_hash",
      "story_id",
    ],
    appendOnly: false,
  },
  storySources: { name: "story_sources", columns: ["story_id", "source_item_id", "relation", "created_at"], appendOnly: false },
  stories: {
    name: "stories",
    columns: [
      "id",
      "status",
      "version",
      "topic",
      "place_tags",
      "risk_tier",
      "risk_flags",
      "disputed",
      "priority",
      "first_seen_at",
      "updated_at",
      "expires_at",
    ],
    appendOnly: false,
  },
  evidence: {
    name: "evidence",
    columns: ["id", "story_id", "kind", "source_item_ids", "editor_login", "method", "attested_at", "created_at"],
    appendOnly: true,
  },
  drafts: {
    name: "drafts",
    columns: [
      "id",
      "story_id",
      "revision",
      "revision_hash",
      "headline_ta",
      "caption_ta",
      "hashtags",
      "alt_text",
      "source_credit_ta",
      "template_version",
      "render_key",
      "render_sha256",
      "origin",
      "created_at",
    ],
    appendOnly: true,
  },
  decisions: {
    name: "decisions",
    columns: ["id", "story_id", "kind", "editor_login", "github_comment_id", "revision_hash", "reason", "scheduled_for", "created_at"],
    appendOnly: true,
  },
  reviewThreads: { name: "review_threads", columns: ["story_id", "issue_number", "last_synced_revision", "updated_at"], appendOnly: false },
  publications: {
    name: "publications",
    columns: [
      "id",
      "story_id",
      "draft_id",
      "idempotency_key",
      "status",
      "scheduled_for",
      "attempts",
      "container_id",
      "container_created_at",
      "publish_requested_at",
      "media_id",
      "permalink",
      "next_attempt_at",
      "lease_owner",
      "lease_expires_at",
      "published_at",
      "last_error",
      "created_at",
      "updated_at",
    ],
    appendOnly: false,
  },
  publishAttempts: {
    name: "publish_attempts",
    columns: ["id", "publication_id", "step", "outcome", "http_status", "error_code", "error_subcode", "is_transient", "detail", "created_at"],
    appendOnly: true,
  },
  jobRuns: {
    name: "job_runs",
    columns: ["id", "workflow", "run_id", "git_sha", "started_at", "finished_at", "status", "counters"],
    appendOnly: false,
  },
  errors: {
    name: "errors",
    columns: ["id", "job_run_id", "stage", "entity_type", "entity_id", "error_class", "code", "message", "retryable", "created_at"],
    appendOnly: true,
  },
} as const satisfies Record<string, TableDef>;

export const TABLE_LIST: readonly TableDef[] = Object.values(TABLES);

/** Changes whenever a table or column changes; jobs refuse to run until the migrate workflow has sent the new layout. */
export const SHEET_SCHEMA_VERSION = createHash("sha256").update(JSON.stringify(TABLE_LIST)).digest("hex").slice(0, 16);
