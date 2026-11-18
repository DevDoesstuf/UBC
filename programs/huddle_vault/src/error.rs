use anchor_lang::prelude::*;

#[error_code]
pub enum VaultError {
    #[msg("The party is not open")]
    PartyNotOpen,
    #[msg("The party is not closing")]
    PartyNotClosing,
    #[msg("The party is not finalized")]
    PartyNotFinalized,
    #[msg("The challenge window is still open")]
    ChallengeWindowOpen,
    #[msg("Challenge window is too long")]
    ChallengeTooLong,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Only the host or the box signer can close before the member timeout")]
    NotAuthorizedToClose,
    #[msg("Members can only request a close after the timeout")]
    MemberCloseTooEarly,
    #[msg("No valid Ed25519 signature by the box signer over this exact state message")]
    MissingBoxSignature,
    #[msg("No valid Ed25519 signature by the member over this exact state message")]
    MissingMemberSignature,
    #[msg("Malformed Ed25519 instruction")]
    MalformedEd25519Instruction,
    #[msg("A state with an equal or higher nonce is already stored")]
    StaleNonce,
    #[msg("Already withdrawn")]
    AlreadyWithdrawn,
    #[msg("Nothing to withdraw")]
    NothingToWithdraw,
    #[msg("Math overflow")]
    MathOverflow,
}
