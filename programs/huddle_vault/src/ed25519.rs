//! Verification of off-chain ed25519 signatures through the native Ed25519 program + instructions sysvar.
//!
//! The transaction carries one or more Ed25519 program instructions *before* `submit_state`. The runtime
//! has already verified every signature those instructions describe (a bad signature fails the whole
//! transaction), so all this module has to prove is *what* was verified: which public key signed which
//! message bytes.
//!
//! Ed25519 instruction data layout:
//!
//! ```text
//! u8  num_signatures
//! u8  padding
//! num_signatures x {            // 14 bytes each
//!   u16 signature_offset            u16 signature_instruction_index
//!   u16 public_key_offset           u16 public_key_instruction_index
//!   u16 message_data_offset         u16 message_data_size
//!   u16 message_instruction_index
//! }
//! ... signature / public key / message bytes ...
//! ```
//!
//! Hardening: each `*_instruction_index` may point at *another* instruction's data. An attacker could
//! then show us an Ed25519 instruction whose bytes look like "box signed message M" while the runtime
//! actually verified data living somewhere else. We therefore only accept entries whose three indexes
//! all refer to the Ed25519 instruction itself (u16::MAX = "this instruction", or its own index), and we
//! read the public key and the message from that same instruction's data with bounds checks.

use anchor_lang::prelude::*;
use solana_instructions_sysvar::{load_current_index_checked, load_instruction_at_checked};

use crate::error::VaultError;
use crate::state::{STATE_DOMAIN, STATE_MESSAGE_LEN};

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

const HEADER_LEN: usize = 2;
const OFFSETS_LEN: usize = 14;
const PUBKEY_LEN: usize = 32;
const SIGNATURE_LEN: usize = 64;

/// The canonical 127-byte signed balance message. Must equal `encodeStateMessage` in @huddle/shared.
pub fn state_message(
    party: &Pubkey,
    member: &Pubkey,
    nonce: u64,
    balance: u64,
    state_hash: &[u8; 32],
) -> [u8; STATE_MESSAGE_LEN] {
    let mut m = [0u8; STATE_MESSAGE_LEN];
    m[0..15].copy_from_slice(STATE_DOMAIN);
    m[15..47].copy_from_slice(party.as_ref());
    m[47..79].copy_from_slice(member.as_ref());
    m[79..87].copy_from_slice(&nonce.to_le_bytes());
    m[87..95].copy_from_slice(&balance.to_le_bytes());
    m[95..127].copy_from_slice(state_hash);
    m
}

fn read_u16(data: &[u8], at: usize) -> Option<u16> {
    let b = data.get(at..at + 2)?;
    Some(u16::from_le_bytes([b[0], b[1]]))
}

/// Which of `signers` have a runtime-verified signature over exactly `message` in one Ed25519
/// instruction's data. `own_index` is that instruction's index in the transaction.
pub fn signers_in_ed25519_ix(data: &[u8], own_index: u16, message: &[u8], signers: &[&Pubkey], found: &mut [bool]) -> Result<()> {
    let num = *data.first().ok_or(VaultError::MalformedEd25519Instruction)? as usize;
    require!(data.len() >= HEADER_LEN + num * OFFSETS_LEN, VaultError::MalformedEd25519Instruction);
    for s in 0..num {
        let base = HEADER_LEN + s * OFFSETS_LEN;
        let malformed = VaultError::MalformedEd25519Instruction;
        let sig_off = read_u16(data, base).ok_or(malformed)? as usize;
        let sig_ix = read_u16(data, base + 2).ok_or(malformed)?;
        let pk_off = read_u16(data, base + 4).ok_or(malformed)? as usize;
        let pk_ix = read_u16(data, base + 6).ok_or(malformed)?;
        let msg_off = read_u16(data, base + 8).ok_or(malformed)? as usize;
        let msg_len = read_u16(data, base + 10).ok_or(malformed)? as usize;
        let msg_ix = read_u16(data, base + 12).ok_or(malformed)?;

        // Only entries that live entirely inside this instruction count (see module docs).
        let is_self = |i: u16| i == u16::MAX || i == own_index;
        if !(is_self(sig_ix) && is_self(pk_ix) && is_self(msg_ix)) {
            continue;
        }
        if sig_off.checked_add(SIGNATURE_LEN).map_or(true, |end| end > data.len()) {
            continue;
        }
        let Some(pk) = data.get(pk_off..pk_off.saturating_add(PUBKEY_LEN)) else { continue };
        let Some(msg) = data.get(msg_off..msg_off.saturating_add(msg_len)) else { continue };
        if msg != message {
            continue;
        }
        for (i, signer) in signers.iter().enumerate() {
            if pk == signer.as_ref() {
                found[i] = true;
            }
        }
    }
    Ok(())
}

/// Scan the instructions before the current one and report, for each of `signers`, whether the
/// transaction contains a runtime-verified ed25519 signature by that key over exactly `message`.
pub fn verified_signers(instructions_sysvar: &AccountInfo, message: &[u8], signers: &[&Pubkey]) -> Result<Vec<bool>> {
    let current = load_current_index_checked(instructions_sysvar)?;
    let mut found = vec![false; signers.len()];
    for index in 0..current {
        let ix = load_instruction_at_checked(index as usize, instructions_sysvar)?;
        if ix.program_id != ED25519_PROGRAM_ID {
            continue;
        }
        signers_in_ed25519_ix(&ix.data, index, message, signers, &mut found)?;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build Ed25519 instruction data with one entry, everything inline (the layout web3.js produces).
    fn ix_data(pk: &[u8; 32], msg: &[u8], idx: (u16, u16, u16)) -> Vec<u8> {
        let pk_off = (HEADER_LEN + OFFSETS_LEN) as u16;
        let sig_off = pk_off + 32;
        let msg_off = sig_off + 64;
        let mut d = vec![1u8, 0u8];
        for v in [sig_off, idx.0, pk_off, idx.1, msg_off, msg.len() as u16, idx.2] {
            d.extend_from_slice(&v.to_le_bytes());
        }
        d.extend_from_slice(pk);
        d.extend_from_slice(&[7u8; 64]);
        d.extend_from_slice(msg);
        d
    }

    fn check(data: &[u8], own: u16, msg: &[u8], signer: &Pubkey) -> bool {
        let mut found = [false];
        signers_in_ed25519_ix(data, own, msg, &[signer], &mut found).unwrap();
        found[0]
    }

    #[test]
    fn message_layout() {
        let party = Pubkey::new_from_array([1; 32]);
        let member = Pubkey::new_from_array([2; 32]);
        let m = state_message(&party, &member, 37, 14_200_000, &[9; 32]);
        assert_eq!(m.len(), 127);
        assert_eq!(&m[0..15], b"HUDDLE_STATE_V1");
        assert_eq!(&m[15..47], &[1; 32]);
        assert_eq!(&m[47..79], &[2; 32]);
        assert_eq!(&m[79..87], &37u64.to_le_bytes());
        assert_eq!(&m[87..95], &14_200_000u64.to_le_bytes());
        assert_eq!(&m[95..127], &[9; 32]);
    }

    #[test]
    fn accepts_self_contained_entry() {
        let signer = Pubkey::new_from_array([3; 32]);
        let msg = [5u8; 127];
        assert!(check(&ix_data(&[3; 32], &msg, (u16::MAX, u16::MAX, u16::MAX)), 0, &msg, &signer));
        assert!(check(&ix_data(&[3; 32], &msg, (2, 2, 2)), 2, &msg, &signer));
    }

    #[test]
    fn rejects_offsets_into_other_instructions() {
        let signer = Pubkey::new_from_array([3; 32]);
        let msg = [5u8; 127];
        for idx in [(1, u16::MAX, u16::MAX), (u16::MAX, 1, u16::MAX), (u16::MAX, u16::MAX, 1)] {
            assert!(!check(&ix_data(&[3; 32], &msg, idx), 0, &msg, &signer));
        }
    }

    #[test]
    fn rejects_wrong_key_or_message() {
        let signer = Pubkey::new_from_array([3; 32]);
        let msg = [5u8; 127];
        let self_idx = (u16::MAX, u16::MAX, u16::MAX);
        assert!(!check(&ix_data(&[4; 32], &msg, self_idx), 0, &msg, &signer));
        let mut other = msg;
        other[90] ^= 1;
        assert!(!check(&ix_data(&[3; 32], &other, self_idx), 0, &msg, &signer));
        assert!(!check(&ix_data(&[3; 32], &msg[..126], self_idx), 0, &msg, &signer));
    }

    #[test]
    fn malformed_header_is_an_error() {
        let signer = Pubkey::new_from_array([3; 32]);
        let mut found = [false];
        assert!(signers_in_ed25519_ix(&[], 0, &[0; 127], &[&signer], &mut found).is_err());
        assert!(signers_in_ed25519_ix(&[2, 0, 1, 2, 3], 0, &[0; 127], &[&signer], &mut found).is_err());
    }
}
