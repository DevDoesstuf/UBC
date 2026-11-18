//! Finalize math. Mirrors `settleClaims` in `packages/shared/src/math/settle.ts` exactly.
//!
//! The program cannot iterate over Member accounts, so `submit_state` keeps two running sums on the
//! Party (`sum_claims`, `claimed_deposits`). At finalize:
//!
//!   finalized_sum = sum_claims + (total_deposits - claimed_deposits)   // unclaimed members default to their deposit
//!   available     = total_deposits + bond
//!
//!   finalized_sum <= available: everyone is paid in full, host_refund = available - finalized_sum
//!   finalized_sum >  available: payout_i = floor(effective_i * available / finalized_sum); the rounding
//!                               dust stays in the vault and is swept to the host by `withdraw_host`
//!                               once every member has withdrawn.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Settlement {
    pub finalized_sum: u128,
    pub available: u64,
    pub cut: bool,
    pub host_refund: u64,
}

pub fn settle(total_deposits: u64, bond: u64, sum_claims: u128, claimed_deposits: u64) -> Option<Settlement> {
    let unclaimed = total_deposits.checked_sub(claimed_deposits)?;
    let finalized_sum = sum_claims.checked_add(unclaimed as u128)?;
    let available = total_deposits.checked_add(bond)?;
    if finalized_sum <= available as u128 {
        Some(Settlement {
            finalized_sum,
            available,
            cut: false,
            host_refund: available - finalized_sum as u64,
        })
    } else {
        Some(Settlement { finalized_sum, available, cut: true, host_refund: 0 })
    }
}

/// A member's final amount. `effective` = claim balance, or the deposit when no claim was submitted.
pub fn payout(effective: u64, cut: bool, available: u64, finalized_sum: u128) -> Option<u64> {
    if !cut {
        return Some(effective);
    }
    if finalized_sum == 0 {
        return None;
    }
    // u64 * u64 always fits in u128; the quotient is <= available because effective <= finalized_sum.
    let p = (effective as u128).checked_mul(available as u128)? / finalized_sum;
    u64::try_from(p).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Reference: the TypeScript `settleClaims` (deposits, claims, bond) -> (payouts, host_refund).
    fn reference(deposits: &[u64], claims: &[Option<u64>], bond: u64) -> (Vec<u64>, u64, bool) {
        let total: u64 = deposits.iter().sum();
        let eff: Vec<u64> = deposits.iter().zip(claims).map(|(d, c)| c.unwrap_or(*d)).collect();
        let sum: u128 = eff.iter().map(|e| *e as u128).sum();
        let available = total + bond;
        if sum <= available as u128 {
            return (eff, available - sum as u64, false);
        }
        let pay: Vec<u64> = eff.iter().map(|e| ((*e as u128 * available as u128) / sum) as u64).collect();
        let paid: u64 = pay.iter().sum();
        (pay, available - paid, true)
    }

    fn on_chain(deposits: &[u64], claims: &[Option<u64>], bond: u64) -> (Vec<u64>, u64, bool) {
        let total: u64 = deposits.iter().sum();
        let mut sum_claims = 0u128;
        let mut claimed_deposits = 0u64;
        for (d, c) in deposits.iter().zip(claims) {
            if let Some(c) = c {
                sum_claims += *c as u128;
                claimed_deposits += d;
            }
        }
        let s = settle(total, bond, sum_claims, claimed_deposits).unwrap();
        let pay: Vec<u64> = deposits
            .iter()
            .zip(claims)
            .map(|(d, c)| payout(c.unwrap_or(*d), s.cut, s.available, s.finalized_sum).unwrap())
            .collect();
        let paid: u64 = pay.iter().sum();
        // host gets host_refund at finalize plus whatever is left after every member withdrew (dust)
        (pay, s.available - paid, s.cut)
    }

    #[test]
    fn matches_reference() {
        let cases: Vec<(Vec<u64>, Vec<Option<u64>>, u64)> = vec![
            (vec![10_000_000, 10_000_000], vec![Some(15_000_000), Some(5_000_000)], 5_000_000),
            (vec![10_000_000, 10_000_000], vec![Some(15_000_000), None], 5_000_000),
            (vec![10_000_000, 10_000_000], vec![Some(18_000_000), None], 5_000_000),
            (vec![10_000_000, 10_000_000, 10_000_000], vec![Some(25_000_001), Some(10_000_000), None], 5_000_000),
            (vec![7, 11, 13], vec![Some(100), Some(3), None], 1),
            (vec![1, 1, 1], vec![Some(u64::MAX), None, Some(0)], 0),
            (vec![], vec![], 5_000_000),
            (vec![10_000_000], vec![Some(0)], 0),
        ];
        for (d, c, b) in cases {
            assert_eq!(on_chain(&d, &c, b), reference(&d, &c, b), "deposits {d:?} claims {c:?} bond {b}");
        }
    }

    #[test]
    fn bond_covers_shortfall_exactly() {
        let s = settle(20, 5, 25, 20).unwrap();
        assert!(!s.cut);
        assert_eq!(s.host_refund, 0);
        let s = settle(20, 5, 26, 20).unwrap();
        assert!(s.cut);
    }
}
