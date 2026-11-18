use anchor_lang::prelude::*;

pub const PARTY_SEED: &[u8] = b"party";
pub const MEMBER_SEED: &[u8] = b"member";
pub const VAULT_SEED: &[u8] = b"vault";

/// Domain tag of the signed balance message (PRD section 8).
pub const STATE_DOMAIN: &[u8; 15] = b"HUDDLE_STATE_V1";
/// "HUDDLE_STATE_V1" (15) || party (32) || member (32) || nonce u64 LE || balance u64 LE || state_hash (32).
pub const STATE_MESSAGE_LEN: usize = 15 + 32 + 32 + 8 + 8 + 32;

/// A member (not the host or the box) may request the close this long after the party was created.
pub const MEMBER_CLOSE_TIMEOUT_SECS: i64 = 6 * 60 * 60;
/// Upper bound on the challenge window so a typo cannot lock a vault for years.
pub const MAX_CHALLENGE_SECS: u32 = 7 * 24 * 60 * 60;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum PartyStatus {
    Open,
    Closing,
    Finalized,
}

/// One watch party. PDA seeds: ["party", host, party_id].
#[account]
#[derive(InitSpace)]
pub struct Party {
    pub host: Pubkey,
    /// Opaque 32-byte id chosen by the host (the client zero-pads or hashes the engine's party id).
    pub party_id: [u8; 32],
    /// Key the box signs balance states with.
    pub box_signer: Pubkey,
    pub mint: Pubkey,
    /// SPL token account owned by this PDA. Seeds: ["vault", party].
    pub vault: Pubkey,
    pub status: PartyStatus,
    /// false = trusted-host mode: only the box signature is required on a state.
    pub require_member_sig: bool,
    pub bump: u8,
    pub vault_bump: u8,
    pub member_count: u32,
    /// Members that have a verified claim.
    pub claims_count: u32,
    /// Members that have withdrawn.
    pub withdrawn_count: u32,
    pub challenge_secs: u32,
    pub created_at: i64,
    pub close_requested_at: i64,
    pub finalized_at: i64,
    /// Sum of all member deposits (the bond is not included).
    pub total_deposits: u64,
    /// Host bond held in the vault.
    pub bond: u64,
    /// Sum of `deposited` over members that have a claim.
    pub claimed_deposits: u64,
    /// Sum of `claim_balance` over members that have a claim.
    pub sum_claims: u128,
    // ----- set by finalize -----
    /// Sum of effective claims: sum_claims + (total_deposits - claimed_deposits). Pro-rata denominator.
    pub finalized_sum: u128,
    /// total_deposits + bond. Pro-rata numerator.
    pub available: u64,
    /// True when claims exceed deposits + bond and every payout is cut pro rata.
    pub cut: bool,
    /// Owed to the host at finalize (remaining bond + surplus). Rounding dust is swept later.
    pub host_refund: u64,
    pub host_refund_paid: bool,
    /// Total paid to members so far.
    pub total_paid: u64,
}

/// One member of one party. PDA seeds: ["member", party, wallet].
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub party: Pubkey,
    pub wallet: Pubkey,
    pub deposited: u64,
    pub claim_balance: u64,
    pub claim_nonce: u64,
    pub claim_state_hash: [u8; 32],
    pub has_claim: bool,
    pub withdrawn: bool,
    /// Amount actually paid by `withdraw`.
    pub paid_out: u64,
    pub bump: u8,
}

// ───────────────────────── events (Anchor `emit!`, "Program data: <base64>" log lines) ─────────────────────────
// Every event starts with the party address so indexers can route without decoding the rest.

#[event]
pub struct PartyCreated {
    pub party: Pubkey,
    pub host: Pubkey,
    pub box_signer: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub party_id: [u8; 32],
    pub bond: u64,
    pub challenge_secs: u32,
    pub require_member_sig: bool,
}

#[event]
pub struct Deposited {
    pub party: Pubkey,
    pub member: Pubkey,
    pub amount: u64,
    /// The member's total deposit after this one.
    pub member_deposited: u64,
    pub total_deposits: u64,
}

#[event]
pub struct CloseRequested {
    pub party: Pubkey,
    pub by: Pubkey,
    pub close_requested_at: i64,
    pub challenge_ends_at: i64,
}

#[event]
pub struct StateSubmitted {
    pub party: Pubkey,
    pub member: Pubkey,
    pub balance: u64,
    pub nonce: u64,
    pub state_hash: [u8; 32],
}

#[event]
pub struct Finalized {
    pub party: Pubkey,
    pub host: Pubkey,
    pub host_refund: u64,
    pub total_deposits: u64,
    pub bond: u64,
    pub available: u64,
    pub finalized_sum: u128,
    pub cut: bool,
}

#[event]
pub struct Withdrawn {
    pub party: Pubkey,
    pub member: Pubkey,
    pub amount: u64,
}

#[event]
pub struct HostWithdrawn {
    pub party: Pubkey,
    pub host: Pubkey,
    pub amount: u64,
}
