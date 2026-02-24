export interface Headline {
  id: number;
  title: string;
  url: string;
  column: "left" | "right" | "center";
  image_url: string | null;
  token_id: number | null;
  created_at: string;
  importance_score: number;
  mcafee_take: string | null;
  wagmi_count: number;
  // Joined token data (optional)
  token?: TokenInfo;
}

export interface TokenInfo {
  ticker: string;
  pump_url: string;
  image_url?: string;
  price_change_24h?: number;
}

export interface MainHeadlineData {
  id: number;
  title: string;
  url: string;
  subtitle: string | null;
  image_url: string | null;
  updated_at: string;
}

export interface CoinOfTheDayData {
  id: number;
  title: string;
  url: string;
  description: string | null;
  image_url: string | null;
  updated_at: string;
}

export interface SetCoinOfTheDayRequest {
  title: string;
  url: string;
  description?: string;
  image_url?: string;
}

export interface WhitelistUser {
  telegram_id: string;
  username: string | null;
  added_at: string;
}

export interface AddHeadlineRequest {
  title: string;
  url: string;
  column?: "left" | "right";
  image_url?: string;
}

export interface SetMainHeadlineRequest {
  title: string;
  url: string;
  subtitle?: string;
  image_url?: string;
}

// ============= SUBMISSION TYPES =============

export type ContentType = "article" | "tweet" | "youtube" | "tiktok" | "other";
export type SubmissionStatus = "pending" | "validating" | "approved" | "rejected" | "published";

export interface Submission {
  id: number;
  telegram_user_id: string;
  telegram_username: string | null;
  sol_address: string;
  url: string;
  content_type: ContentType;
  status: SubmissionStatus;
  rejection_reason: string | null;
  content_hash: string | null;
  embedding: string | null; // JSON stringified array for semantic search
  cached_content: string | null; // JSON stringified PageContent from validation
  custom_token_name: string | null;
  custom_ticker: string | null;
  custom_image_url: string | null;
  memeify_image: number; // 0 = use as-is, 1 = meme-ify via OpenAI
  published_at: string | null;
  created_at: string;
}

export interface CreateSubmissionRequest {
  telegram_user_id: string;
  telegram_username?: string;
  sol_address: string;
  url: string;
  content_type?: ContentType;
  custom_token_name?: string;
  custom_ticker?: string;
  custom_image_url?: string;
  memeify_image?: boolean;
}

// ============= TOKEN TYPES =============

export interface Token {
  id: number;
  headline_id: number | null;
  submission_id: number | null;
  token_name: string;
  ticker: string;
  image_url: string | null;
  mint_address: string | null;
  pump_url: string | null;
  deployer_sol_address: string;
  /** Ephemeral deployer wallet public key (null for legacy master-wallet deploys). */
  creator_wallet_address: string | null;
  /** AES-256-GCM encrypted base58 private key of the ephemeral deployer. */
  creator_wallet_encrypted_key: string | null;
  /** ISO timestamp of the last successful creator-fee claim for this token. */
  last_fee_claim_at: string | null;
  /** The meme theme ID used when generating this token (for analytics). */
  theme: string | null;
  created_at: string;
}

export interface CreateTokenRequest {
  headline_id?: number;
  submission_id?: number;
  token_name: string;
  ticker: string;
  image_url?: string;
  mint_address?: string;
  pump_url?: string;
  deployer_sol_address: string;
}

// ============= REVENUE TYPES =============

export type RevenueStatus = "pending" | "submitter_paid" | "burned" | "completed" | "failed";

export interface RevenueEvent {
  id: number;
  token_id: number;
  amount_lamports: number;
  submitter_share_lamports: number;
  burn_share_lamports: number;
  submitter_tx_signature: string | null;
  burn_tx_signature: string | null;
  status: RevenueStatus;
  created_at: string;
}

export interface CreateRevenueEventRequest {
  token_id: number;
  amount_lamports: number;
}

// ============= CLAIM DISTRIBUTION TYPES =============

export type ClaimBatchStatus = "pending" | "distributing" | "completed" | "failed";
export type ClaimAllocationStatus = "pending" | "paid" | "failed" | "skipped";

/** A bulk claim event from pump.fun (one claim tx = one batch). */
export interface ClaimBatch {
  id: number;
  tx_signature: string;
  total_lamports: number;
  tokens_count: number;
  distributed_lamports: number;
  status: ClaimBatchStatus;
  created_at: string;
}

/** Per-token allocation within a claim batch. */
export interface ClaimAllocation {
  id: number;
  batch_id: number;
  token_id: number;
  volume_snapshot: number;
  share_percent: number;
  amount_lamports: number;
  submitter_lamports: number;
  submitter_tx_signature: string | null;
  status: ClaimAllocationStatus;
  created_at: string;
}

/** Volume snapshot for delta calculation between claims. */
export interface TokenVolumeSnapshot {
  id: number;
  token_id: number;
  cumulative_volume: number;
  snapshot_source: string;
  created_at: string;
}

// ============= VALIDATION TYPES =============

export interface ValidationResult {
  isValid: boolean;
  factScore: number;       // 0-100
  freshnessHours: number;  // Age in hours
  duplicateOf?: number;    // submission_id if duplicate
  rejectionReason?: string;
}

export interface PageContent {
  title: string;
  description: string;
  content: string;
  imageUrl: string | null;
  publishedAt?: Date;
}

// ============= TOKEN GENERATION TYPES =============

export interface TokenMetadata {
  name: string;
  ticker: string;
  imageUrl: string;
  bannerUrl: string;
  description: string;
  /** Legacy: meme theme ID (no longer used for new tokens). */
  theme?: string;
}

// ============= VOTE TYPES =============

export interface Vote {
  id: number;
  headline_id: number;
  vote_type: "wagmi" | "ngmi";
  voter_hash: string;
  created_at: string;
}

export interface VoteCounts {
  wagmi: number;
  ngmi: number;
}

// ============= ACTIVITY LOG TYPES =============

export type ActivityEventType =
  | "submission_received"
  | "validation_started"
  | "approved"
  | "rejected"
  | "not_selected"
  | "token_minted"
  | "headline_published"
  | "vote_cast";

export interface ActivityEvent {
  id: number;
  event_type: ActivityEventType;
  message: string;
  metadata: string | null;
  created_at: string;
}

// ============= DEPLOYER POOL TYPES =============

export type PoolWalletStatus = "ready" | "reserved" | "used" | "failed";

export interface PoolWallet {
  id: number;
  address: string;
  encrypted_key: string;
  funded_at: string;
  funded_lamports: number;
  status: PoolWalletStatus;
  reserved_at: string | null;
  used_at: string | null;
  token_id: number | null;
  created_at: string;
}

export interface PoolStats {
  ready: number;
  reserved: number;
  used: number;
  failed: number;
  total: number;
}

// ============= STATE MACHINE =============

/** Valid status transitions – enforced by db.updateSubmissionStatus */
export const VALID_STATUS_TRANSITIONS: Record<SubmissionStatus, SubmissionStatus[]> = {
  pending: ["validating", "rejected"],
  validating: ["approved", "rejected"],
  approved: ["published", "rejected"],
  rejected: [],   // Terminal state
  published: [],  // Terminal state
};
