//! Huddle party vault (PRD section 8). DEVNET ONLY.
//!
//! Money goes into an SPL token vault at buy-in. Bets happen off-chain as balance states co-signed by
//! the box and the member. At the end the vault pays out from the latest co-signed states:
//!
//!   create_party -> deposit* -> request_close -> submit_state* -> (challenge window) -> finalize
//!   -> withdraw* (crank, per member) + withdraw_host
//!
//! Nobody can move vault funds except through `withdraw` (to a member's own associated token account)
//! and `withdraw_host` (to the host's own associated token account).

pub mod ed25519;
pub mod error;
pub mod settle;
pub mod state;

use anchor_lang::prelude::*;
use solana_instructions_sysvar::ID as INSTRUCTIONS_SYSVAR_ID;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, TransferChecked};

pub use error::VaultError;
pub use state::*;

declare_id!("GRpABdrQhDya9n2zuf19w2idbL3CRSqmWYTJs52taRHu");

#[program]
pub mod huddle_vault {
    use super::*;

    /// The host creates the party and deposits the bond into the vault.
    /// `payer` (the treasury) pays rent and fees, so the host key needs no SOL.
    pub fn create_party(
        ctx: Context<CreateParty>,
        party_id: [u8; 32],
        box_signer: Pubkey,
        challenge_secs: u32,
        bond: u64,
        require_member_sig: bool,
    ) -> Result<()> {
        require!(challenge_secs <= MAX_CHALLENGE_SECS, VaultError::ChallengeTooLong);

        let party = &mut ctx.accounts.party;
        party.host = ctx.accounts.host.key();
        party.party_id = party_id;
        party.box_signer = box_signer;
        party.mint = ctx.accounts.mint.key();
        party.vault = ctx.accounts.vault.key();
        party.status = PartyStatus::Open;
        party.require_member_sig = require_member_sig;
        party.bump = ctx.bumps.party;
        party.vault_bump = ctx.bumps.vault;
        party.member_count = 0;
        party.claims_count = 0;
        party.withdrawn_count = 0;
        party.challenge_secs = challenge_secs;
        party.created_at = Clock::get()?.unix_timestamp;
        party.close_requested_at = 0;
        party.finalized_at = 0;
        party.total_deposits = 0;
        party.bond = bond;
        party.claimed_deposits = 0;
        party.sum_claims = 0;
        party.finalized_sum = 0;
        party.available = 0;
        party.cut = false;
        party.host_refund = 0;
        party.host_refund_paid = false;
        party.total_paid = 0;

        if bond > 0 {
            token::transfer_checked(
                CpiContext::new(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.host_token.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.host.to_account_info(),
                    },
                ),
                bond,
                ctx.accounts.mint.decimals,
            )?;
        }

        emit!(PartyCreated {
            party: party.key(),
            host: party.host,
            box_signer,
            mint: party.mint,
            vault: party.vault,
            party_id,
            bond,
            challenge_secs,
            require_member_sig,
        });
        Ok(())
    }

    /// Buy in. Creates the Member account on first deposit. `payer` (the treasury) pays rent and fees;
    /// the member only signs for the token transfer, so players never need SOL.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(amount > 0, VaultError::ZeroAmount);
        let party = &mut ctx.accounts.party;
        require!(party.status == PartyStatus::Open, VaultError::PartyNotOpen);

        let member = &mut ctx.accounts.member_account;
        if member.wallet == Pubkey::default() {
            member.party = party.key();
            member.wallet = ctx.accounts.member.key();
            member.deposited = 0;
            member.claim_balance = 0;
            member.claim_nonce = 0;
            member.claim_state_hash = [0u8; 32];
            member.has_claim = false;
            member.withdrawn = false;
            member.paid_out = 0;
            member.bump = ctx.bumps.member_account;
            party.member_count = party.member_count.checked_add(1).ok_or(VaultError::MathOverflow)?;
        }
        member.deposited = member.deposited.checked_add(amount).ok_or(VaultError::MathOverflow)?;
        party.total_deposits = party.total_deposits.checked_add(amount).ok_or(VaultError::MathOverflow)?;

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.member_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.member.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(Deposited {
            party: party.key(),
            member: member.wallet,
            amount,
            member_deposited: member.deposited,
            total_deposits: party.total_deposits,
        });
        Ok(())
    }

    /// Start the challenge window. The host or the box signer can do it at any time; any member can
    /// do it once the party is older than `MEMBER_CLOSE_TIMEOUT_SECS` (so a dead box cannot lock funds).
    pub fn request_close(ctx: Context<RequestClose>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let party = &mut ctx.accounts.party;
        require!(party.status == PartyStatus::Open, VaultError::PartyNotOpen);

        let signer = ctx.accounts.signer.key();
        if signer != party.host && signer != party.box_signer {
            // The seeds constraint already ties `member_account` to (party, signer).
            require!(ctx.accounts.member_account.is_some(), VaultError::NotAuthorizedToClose);
            let unlocks_at = party.created_at.checked_add(MEMBER_CLOSE_TIMEOUT_SECS).ok_or(VaultError::MathOverflow)?;
            require!(now >= unlocks_at, VaultError::MemberCloseTooEarly);
        }

        party.status = PartyStatus::Closing;
        party.close_requested_at = now;

        emit!(CloseRequested {
            party: party.key(),
            by: signer,
            close_requested_at: now,
            challenge_ends_at: now.checked_add(party.challenge_secs as i64).ok_or(VaultError::MathOverflow)?,
        });
        Ok(())
    }

    /// Submit a member's signed balance during Closing. Anyone can submit. The transaction must carry
    /// Ed25519 program instruction(s), before this one, that verify the canonical 127-byte message
    ///
    ///   "HUDDLE_STATE_V1" || party || member || nonce u64 LE || balance u64 LE || state_hash
    ///
    /// for the box signer and, when `require_member_sig` is set, for the member wallet as well.
    /// The claim is kept only if its nonce is higher than the stored one.
    pub fn submit_state(
        ctx: Context<SubmitState>,
        member: Pubkey,
        nonce: u64,
        balance: u64,
        state_hash: [u8; 32],
    ) -> Result<()> {
        let party = &mut ctx.accounts.party;
        require!(party.status == PartyStatus::Closing, VaultError::PartyNotClosing);

        let message = ed25519::state_message(&party.key(), &member, nonce, balance, &state_hash);
        let ok = ed25519::verified_signers(
            &ctx.accounts.instructions_sysvar.to_account_info(),
            &message,
            &[&party.box_signer, &member],
        )?;
        require!(ok[0], VaultError::MissingBoxSignature);
        if party.require_member_sig {
            require!(ok[1], VaultError::MissingMemberSignature);
        }

        let m = &mut ctx.accounts.member_account;
        require!(!m.has_claim || nonce > m.claim_nonce, VaultError::StaleNonce);

        if m.has_claim {
            party.sum_claims = party.sum_claims.checked_sub(m.claim_balance as u128).ok_or(VaultError::MathOverflow)?;
        } else {
            party.claimed_deposits = party.claimed_deposits.checked_add(m.deposited).ok_or(VaultError::MathOverflow)?;
            party.claims_count = party.claims_count.checked_add(1).ok_or(VaultError::MathOverflow)?;
        }
        party.sum_claims = party.sum_claims.checked_add(balance as u128).ok_or(VaultError::MathOverflow)?;

        m.has_claim = true;
        m.claim_nonce = nonce;
        m.claim_balance = balance;
        m.claim_state_hash = state_hash;

        emit!(StateSubmitted { party: party.key(), member, balance, nonce, state_hash });
        Ok(())
    }

    /// After the challenge window, anyone can finalize. See `settle.rs` for the math.
    pub fn finalize(ctx: Context<Finalize>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let party = &mut ctx.accounts.party;
        require!(party.status == PartyStatus::Closing, VaultError::PartyNotClosing);
        let ends_at = party.close_requested_at.checked_add(party.challenge_secs as i64).ok_or(VaultError::MathOverflow)?;
        require!(now >= ends_at, VaultError::ChallengeWindowOpen);

        let s = settle::settle(party.total_deposits, party.bond, party.sum_claims, party.claimed_deposits)
            .ok_or(VaultError::MathOverflow)?;
        party.status = PartyStatus::Finalized;
        party.finalized_at = now;
        party.finalized_sum = s.finalized_sum;
        party.available = s.available;
        party.cut = s.cut;
        party.host_refund = s.host_refund;

        emit!(Finalized {
            party: party.key(),
            host: party.host,
            host_refund: s.host_refund,
            total_deposits: party.total_deposits,
            bond: party.bond,
            available: s.available,
            finalized_sum: s.finalized_sum,
            cut: s.cut,
        });
        Ok(())
    }

    /// Pay a member's final amount to the member's own associated token account. Anyone can crank it.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let party = &mut ctx.accounts.party;
        require!(party.status == PartyStatus::Finalized, VaultError::PartyNotFinalized);
        let m = &mut ctx.accounts.member_account;
        require!(!m.withdrawn, VaultError::AlreadyWithdrawn);

        let effective = if m.has_claim { m.claim_balance } else { m.deposited };
        let amount = settle::payout(effective, party.cut, party.available, party.finalized_sum)
            .ok_or(VaultError::MathOverflow)?;

        m.withdrawn = true;
        m.paid_out = amount;
        party.withdrawn_count = party.withdrawn_count.checked_add(1).ok_or(VaultError::MathOverflow)?;
        party.total_paid = party.total_paid.checked_add(amount).ok_or(VaultError::MathOverflow)?;

        if amount > 0 {
            let seeds: &[&[u8]] = &[PARTY_SEED, party.host.as_ref(), party.party_id.as_ref(), &[party.bump]];
            token::transfer_checked(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.key(),
                    TransferChecked {
                        from: ctx.accounts.vault.to_account_info(),
                        mint: ctx.accounts.mint.to_account_info(),
                        to: ctx.accounts.wallet_token.to_account_info(),
                        authority: party.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
                ctx.accounts.mint.decimals,
            )?;
        }

        emit!(Withdrawn { party: party.key(), member: m.wallet, amount });
        Ok(())
    }

    /// Pay the host. Anyone can crank it; funds only go to the host's own associated token account.
    ///  - First call after finalize: `host_refund` (remaining bond + surplus).
    ///  - Once every member has withdrawn: everything left in the vault (pro-rata rounding dust).
    pub fn withdraw_host(ctx: Context<WithdrawHost>) -> Result<()> {
        let party = &mut ctx.accounts.party;
        require!(party.status == PartyStatus::Finalized, VaultError::PartyNotFinalized);

        let all_members_paid = party.withdrawn_count == party.member_count;
        let amount = if all_members_paid {
            ctx.accounts.vault.amount
        } else if !party.host_refund_paid {
            party.host_refund
        } else {
            0
        };
        require!(amount > 0, VaultError::NothingToWithdraw);
        party.host_refund_paid = true;

        let seeds: &[&[u8]] = &[PARTY_SEED, party.host.as_ref(), party.party_id.as_ref(), &[party.bump]];
        token::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.host_token.to_account_info(),
                    authority: party.to_account_info(),
                },
                &[seeds],
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        emit!(HostWithdrawn { party: party.key(), host: party.host, amount });
        Ok(())
    }
}

// ───────────────────────── accounts ─────────────────────────

#[derive(Accounts)]
#[instruction(party_id: [u8; 32])]
pub struct CreateParty<'info> {
    /// Rent + fee payer (the treasury). May be the host itself.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub host: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = 8 + Party::INIT_SPACE,
        seeds = [PARTY_SEED, host.key().as_ref(), party_id.as_ref()],
        bump
    )]
    pub party: Box<Account<'info, Party>>,
    pub mint: Box<Account<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        seeds = [VAULT_SEED, party.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = party
    )]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// The host's token account the bond is taken from.
    #[account(mut, token::mint = mint, token::authority = host)]
    pub host_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    /// Rent + fee payer (the treasury). May be the member itself.
    #[account(mut)]
    pub payer: Signer<'info>,
    pub member: Signer<'info>,
    #[account(mut, seeds = [PARTY_SEED, party.host.as_ref(), party.party_id.as_ref()], bump = party.bump)]
    pub party: Box<Account<'info, Party>>,
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + Member::INIT_SPACE,
        seeds = [MEMBER_SEED, party.key().as_ref(), member.key().as_ref()],
        bump
    )]
    pub member_account: Box<Account<'info, Member>>,
    #[account(address = party.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = member)]
    pub member_token: Box<Account<'info, TokenAccount>>,
    #[account(mut, address = party.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RequestClose<'info> {
    pub signer: Signer<'info>,
    #[account(mut, seeds = [PARTY_SEED, party.host.as_ref(), party.party_id.as_ref()], bump = party.bump)]
    pub party: Box<Account<'info, Party>>,
    /// Only needed when the signer is a member (not the host or the box). Pass the program id for "none".
    #[account(seeds = [MEMBER_SEED, party.key().as_ref(), signer.key().as_ref()], bump = member_account.bump)]
    pub member_account: Option<Box<Account<'info, Member>>>,
}

#[derive(Accounts)]
#[instruction(member: Pubkey)]
pub struct SubmitState<'info> {
    #[account(mut, seeds = [PARTY_SEED, party.host.as_ref(), party.party_id.as_ref()], bump = party.bump)]
    pub party: Box<Account<'info, Party>>,
    #[account(mut, seeds = [MEMBER_SEED, party.key().as_ref(), member.as_ref()], bump = member_account.bump)]
    pub member_account: Box<Account<'info, Member>>,
    /// CHECK: the instructions sysvar, checked by address.
    #[account(address = INSTRUCTIONS_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, seeds = [PARTY_SEED, party.host.as_ref(), party.party_id.as_ref()], bump = party.bump)]
    pub party: Box<Account<'info, Party>>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    /// Crank: pays fees and, if needed, rent for the member's associated token account.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PARTY_SEED, party.host.as_ref(), party.party_id.as_ref()], bump = party.bump)]
    pub party: Box<Account<'info, Party>>,
    #[account(mut, seeds = [MEMBER_SEED, party.key().as_ref(), wallet.key().as_ref()], bump = member_account.bump)]
    pub member_account: Box<Account<'info, Member>>,
    /// CHECK: the member's wallet. Tied to `member_account` by its seeds; only used as the ATA owner.
    pub wallet: UncheckedAccount<'info>,
    #[account(address = party.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = party.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    /// The member's own associated token account: the only place a member payout can go.
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = wallet)]
    pub wallet_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawHost<'info> {
    /// Crank: pays fees and, if needed, rent for the host's associated token account.
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [PARTY_SEED, party.host.as_ref(), party.party_id.as_ref()], bump = party.bump)]
    pub party: Box<Account<'info, Party>>,
    /// CHECK: must be the party host; only used as the ATA owner.
    #[account(address = party.host)]
    pub host: UncheckedAccount<'info>,
    #[account(address = party.mint)]
    pub mint: Box<Account<'info, Mint>>,
    #[account(mut, address = party.vault)]
    pub vault: Box<Account<'info, TokenAccount>>,
    #[account(init_if_needed, payer = payer, associated_token::mint = mint, associated_token::authority = host)]
    pub host_token: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
